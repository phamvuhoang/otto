import { spawnSync } from "node:child_process";

import type {
  CompressInput,
  ContextCompressor,
  SyncContextCompressor,
} from "./context-compressor.js";
import type { SafetyPolicy } from "./safety-policy.js";
import type { SafetyEvent } from "./run-report.js";
import { authorizeToolInvocation } from "./tools.js";
import type { ToolConfig, ToolDefinition } from "./tools.js";

/**
 * Headroom adapter (issue #112 P20).
 * [Headroom](https://github.com/headroomlabs-ai/headroom) compresses token-heavy
 * content (tool outputs, logs, RAG chunks, files, history). A
 * {@link headroomToolDefinition} entry under `.otto/tools/` makes it
 * `otto-tools list`/`health`-visible and governs it: {@link authorizeCompressor}
 * honors the tool's `enabled` flag and authorizes its command against
 * `.otto/policy.json`. It is **not** *stage*-gated, though — the compressor runs
 * at the render boundary, not per stage ([#192](https://github.com/phamvuhoang/otto/issues/192)).
 *
 * Otto drives Headroom's real `compress(messages, model)` library through a
 * synchronous subprocess (the render/`@spill` boundary cannot await). Two runners
 * sit behind one {@link HeadroomRunner} contract:
 *
 * - **library mode (default):** spawn `python3 -c <bridge>` calling
 *   `from headroom import compress` — Headroom's documented, model-backed API.
 *   Each compression is an LLM call, so it needs a model key (e.g.
 *   `OPENAI_API_KEY`) and `HEADROOM_MODEL` (default `gpt-4o-mini`); the
 *   interpreter is overridable via `OTTO_HEADROOM_PYTHON`.
 * - **command mode:** when `OTTO_HEADROOM_BIN` is set, shell out to that binary
 *   with `compress --category <c>` (stdin → compressed stdout) — an escape hatch
 *   for a custom compressor that already speaks this contract.
 *
 * {@link resolveHeadroomRunner} picks the mode. Everything is injectable (the
 * runner and its `spawn`) so tests never spawn a real process, and a missing
 * interpreter / library / key degrades cleanly (the compressor reports
 * unavailable or `ok: false` and the orchestrator keeps the original content).
 */

/** Compressor identity recorded on each compression (mode-agnostic). */
export const HEADROOM_VERSION = "headroom-1";

/** The injectable process spawner (defaults to `spawnSync`); tests pass a fake. */
type Spawn = typeof spawnSync;

/**
 * The low-level transport the adapter drives. The default shells out to the
 * `headroom` CLI; tests inject a double. `available` is the health probe;
 * `run` performs one compression.
 */
export type HeadroomRunner = {
  available: () => boolean;
  run: (input: CompressInput) => { ok: boolean; text: string; note?: string };
};

/** Resolve the headroom binary name (env override, else `headroom`). */
function headroomBin(env: NodeJS.ProcessEnv): string {
  const b = env.OTTO_HEADROOM_BIN;
  return typeof b === "string" && b.length > 0 ? b : "headroom";
}

/** Resolve the Python interpreter for library mode (env override, else `python3`). */
function pythonBin(env: NodeJS.ProcessEnv): string {
  const p = env.OTTO_HEADROOM_PYTHON;
  return typeof p === "string" && p.length > 0 ? p : "python3";
}

/**
 * The Python bridge driven in library mode: read the spill text on stdin, run it
 * through Headroom's `compress(messages, model)`, and write the compressed text to
 * stdout. Built line-by-line (Python is whitespace-sensitive) so it survives as a
 * `python3 -c` argument. Exit codes are diagnostic only — any non-zero exit is a
 * recoverable failure the orchestrator turns into a degraded passthrough:
 *   2 = library not importable, 1 = compress() raised (e.g. missing key),
 *   3 = empty output (never blank out a non-empty spill).
 */
export const HEADROOM_BRIDGE = [
  "import sys, os",
  "try:",
  "    from headroom import compress",
  "except Exception as e:",
  "    sys.stderr.write('headroom import failed: %s' % e); sys.exit(2)",
  "text = sys.stdin.read()",
  "model = os.environ.get('HEADROOM_MODEL', 'gpt-4o-mini')",
  "try:",
  "    result = compress([{'role': 'user', 'content': text}], model=model)",
  "except Exception as e:",
  "    sys.stderr.write('headroom compress failed: %s' % e); sys.exit(1)",
  "msgs = getattr(result, 'messages', None)",
  "if msgs is None:",
  "    msgs = result if isinstance(result, list) else []",
  "parts = []",
  "for m in msgs:",
  "    c = m.get('content') if isinstance(m, dict) else getattr(m, 'content', '')",
  "    if c:",
  "        parts.append(c)",
  "out = '\\n'.join(parts)",
  "if not out.strip():",
  "    sys.stderr.write('headroom returned empty output'); sys.exit(3)",
  "sys.stdout.write(out)",
].join("\n");

/** Map a finished spawn result onto the runner's `{ok,text,note}` contract. */
function fromSpawn(
  r: ReturnType<Spawn>,
  fallbackText: string
): { ok: boolean; text: string; note?: string } {
  if (r.status !== 0 || typeof r.stdout !== "string") {
    const stderr =
      typeof r.stderr === "string" && r.stderr.trim() ? r.stderr.trim() : "";
    return {
      ok: false,
      text: fallbackText,
      note: r.error?.message ?? (stderr || `headroom exit ${r.status}`),
    };
  }
  return { ok: true, text: r.stdout };
}

/**
 * Library-mode runner (default): probe `python3 -c "import headroom"` for
 * availability, then run {@link HEADROOM_BRIDGE} per compression. Honors
 * `OTTO_HEADROOM_PYTHON`; the LLM call inside `compress()` needs a model key.
 */
export function libraryHeadroomRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
  spawn: Spawn = spawnSync
): HeadroomRunner {
  const py = pythonBin(env);
  return {
    available: () => {
      try {
        return (
          spawn(py, ["-c", "import headroom"], { timeout: 5_000 }).status === 0
        );
      } catch {
        return false;
      }
    },
    run: (input) =>
      fromSpawn(
        spawn(py, ["-c", HEADROOM_BRIDGE], {
          input: input.text,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        }),
        input.text
      ),
  };
}

/**
 * Command-mode runner: `<bin> --version` for availability, and
 * `<bin> compress --category <c>` (content on stdin → compressed stdout) for one
 * compression. Selected only when `OTTO_HEADROOM_BIN` is set — a custom compressor
 * already speaking this contract. A non-zero exit / spawn error degrades cleanly.
 */
export function defaultHeadroomRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
  spawn: Spawn = spawnSync
): HeadroomRunner {
  const bin = headroomBin(env);
  return {
    available: () => {
      try {
        return spawn(bin, ["--version"], { timeout: 5_000 }).status === 0;
      } catch {
        return false;
      }
    },
    run: (input) =>
      fromSpawn(
        spawn(bin, ["compress", "--category", input.category], {
          input: input.text,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        }),
        input.text
      ),
  };
}

/**
 * Pick the runner: command mode when `OTTO_HEADROOM_BIN` is set (custom binary),
 * else library mode (Headroom's `compress()` via the Python bridge). The default
 * for both compressor factories.
 */
export function resolveHeadroomRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
  spawn: Spawn = spawnSync
): HeadroomRunner {
  const bin = env.OTTO_HEADROOM_BIN;
  return typeof bin === "string" && bin.length > 0
    ? defaultHeadroomRunner(env, timeoutMs, spawn)
    : libraryHeadroomRunner(env, timeoutMs, spawn);
}

/**
 * Build a {@link ContextCompressor} over a {@link HeadroomRunner}. Availability
 * is cached per instance after the first probe so a run does not re-spawn
 * `headroom --version` for every compression.
 */
export function createHeadroomCompressor(
  runner: HeadroomRunner = resolveHeadroomRunner()
): ContextCompressor {
  let probed: boolean | undefined;
  return {
    name: "headroom",
    version: HEADROOM_VERSION,
    isAvailable: () => {
      if (probed === undefined) probed = runner.available();
      return probed;
    },
    compress: (input) => Promise.resolve(runner.run(input)),
  };
}

/**
 * Build a {@link SyncContextCompressor} over a {@link HeadroomRunner} for the
 * sync render/`@spill` path. Availability is probed once at construction (one
 * `headroom --version` per run). The runner is synchronous (spawnSync), so this
 * needs no event loop — exactly what `renderTemplate` requires.
 */
export function createHeadroomSyncCompressor(
  runner: HeadroomRunner = resolveHeadroomRunner()
): SyncContextCompressor {
  return {
    name: "headroom",
    version: HEADROOM_VERSION,
    available: runner.available(),
    compress: (input) => runner.run(input),
  };
}

/**
 * The {@link ToolDefinition} a repo drops into `.otto/tools/headroom.json`. It is
 * the registry/`otto-tools` surface and the governance hook ({@link
 * authorizeCompressor} reads its `enabled` flag and authorizes its `command`
 * against policy). `stages: []` is irrelevant to the compressor — it runs at the
 * render boundary, not per stage — so it is NOT stage-gated. Returned as a value
 * so `otto-extensions` (P21 `context-saver`) can generate it.
 */
export function headroomToolDefinition(): ToolDefinition {
  return {
    name: "headroom",
    kind: "command",
    description:
      "Context compressor (Headroom library mode, model-backed): compresses token-heavy @spill content via headroom-ai's compress(); needs a model API key.",
    capabilities: ["compression", "context-engineering"],
    stages: [],
    command: "python3 -c 'from headroom import compress'",
    env: ["OTTO_HEADROOM_BIN", "OTTO_HEADROOM_PYTHON", "HEADROOM_MODEL"],
    networkDomains: [],
    writeRoots: [],
    secretRefs: [],
    approvalActions: [],
    timeoutMs: 30_000,
    // Mirror runtime resolution (#192 part 3): probe the same binary a run would —
    // `$OTTO_HEADROOM_BIN --version` in command mode, else the (overridable)
    // interpreter's `import headroom` in library mode — so health agrees with runs.
    healthCheck:
      'if [ -n "$OTTO_HEADROOM_BIN" ]; then "$OTTO_HEADROOM_BIN" --version; else "${OTTO_HEADROOM_PYTHON:-python3}" -c "import headroom"; fi',
    enabled: true,
  };
}

/** The compressor governance verdict (issue #192 part 2). */
export type CompressorAuthorization = {
  allowed: boolean;
  reason: string;
  /** Blocked `policy-violation` events when a registered tool's command is denied. */
  events: SafetyEvent[];
};

/**
 * Gate the compressor on tool-registry + policy authority (issue #192 part 2).
 * The compressor is a render-boundary concern, not a per-stage tool, so it is NOT
 * stage-gated (a registered `headroom` tool's `stages: []` is irrelevant here).
 * But when a repo registers the `headroom` tool, the registry and policy DO govern
 * it:
 *
 * - no `headroom` tool registered → allowed (config/flag-driven, unchanged — so a
 *   bare repo that only sets `--context-compressor headroom` behaves as before);
 * - tool disabled (registry `enabled: false` or a config override) → denied;
 * - the tool's declared `command` blocked by `.otto/policy.json` → denied, with
 *   the blocked {@link SafetyEvent}s for the evidence bundle.
 *
 * Pure: the registry, config, and policy are injected (the loop reads them from
 * the workspace). Default policy + no override always allows.
 */
export function authorizeCompressor(
  tools: ToolDefinition[],
  config: ToolConfig,
  policy: SafetyPolicy
): CompressorAuthorization {
  const tool = tools.find((t) => t.name === "headroom");
  if (!tool) {
    return {
      allowed: true,
      reason: "no headroom tool registered — config-driven",
      events: [],
    };
  }
  const enabled = config.overrides[tool.name]?.enabled ?? tool.enabled;
  if (!enabled) {
    return {
      allowed: false,
      reason: "headroom tool disabled in registry/config",
      events: [],
    };
  }
  const auth = authorizeToolInvocation(policy, tool, { command: tool.command });
  if (!auth.allowed) {
    const kinds = auth.violations.map((v) => v.kind).join(", ");
    return {
      allowed: false,
      reason: `headroom tool command blocked by policy (${kinds})`,
      events: auth.events,
    };
  }
  return {
    allowed: true,
    reason: "authorized by registry + policy",
    events: [],
  };
}
