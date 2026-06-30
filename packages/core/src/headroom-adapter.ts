import { spawnSync } from "node:child_process";

import { COMPRESSION_CATEGORIES } from "./context-compressor.js";
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
 *   `from headroom import compress` — Headroom's documented API (needs the
 *   `headroom-ai[ml]` extra; the base package leaves plain text unchanged).
 *   Inference is **local** with **no per-call API/cost** (`HEADROOM_MODEL` only
 *   selects the tokenizer), but the ML model is **downloaded once from Hugging
 *   Face** (~260–600 MB) on first use — a network fetch Otto does not proxy or
 *   gate, so pre-warm it (`HF_HUB_OFFLINE=1` / `HF_ENDPOINT`). The interpreter is
 *   overridable via `OTTO_HEADROOM_PYTHON`.
 * - **command mode:** when `OTTO_HEADROOM_BIN` is set, shell out to that binary
 *   with `compress --category <c>` (stdin → compressed stdout) — an escape hatch
 *   for a custom compressor that already speaks this contract.
 *
 * {@link resolveHeadroomRunner} picks the mode. Everything is injectable (the
 * runner and its `spawn`) so tests never spawn a real process, and a missing
 * interpreter / library degrades cleanly (the compressor reports unavailable or
 * `ok: false` and the orchestrator keeps the original content).
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

/** The Hugging Face hosts the ML model is fetched from by default (no HF_ENDPOINT). */
const HF_DEFAULT_DOMAINS = ["huggingface.co", "cdn-lfs.huggingface.co"];

/**
 * Whether the compressor subprocess runs offline. Otto forces `HF_HUB_OFFLINE=1`
 * by default (the runner injects `env.HF_HUB_OFFLINE ?? "1"`), and this MUST match
 * Hugging Face's own parsing so {@link authorizeCompressor}'s "can it reach the
 * network?" matches reality: HF treats only `1`/`true`/`yes`/`on` (case-insensitive)
 * as offline — every other value (e.g. `maybe`) is **online**. Treating an
 * unrecognized value as offline would skip policy authorization while the run
 * actually went online.
 */
export function headroomOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.HF_HUB_OFFLINE ?? "1").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * The network host(s) the ML model fetch would ACTUALLY reach, resolved from env
 * like Hugging Face does: `HF_ENDPOINT` (its host) overrides the default HF hosts.
 * Authorizing the resolved endpoint — not the static `tool.networkDomains` — closes
 * the gap where `HF_ENDPOINT=https://evil.example` would slip past a policy that
 * only allows `huggingface.co`.
 */
export function headroomNetworkDomains(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const ep = env.HF_ENDPOINT;
  if (typeof ep === "string" && ep.length > 0) {
    try {
      return [new URL(ep).hostname];
    } catch {
      return [ep];
    }
  }
  return [...HF_DEFAULT_DOMAINS];
}

/**
 * The Python bridge driven in library mode: read the spill text on stdin, run it
 * through Headroom's `compress(messages, model)`, and write the compressed text to
 * stdout. Built line-by-line (Python is whitespace-sensitive) so it survives as a
 * `python3 -c` argument. Exit codes are diagnostic only — any non-zero exit is a
 * recoverable failure the orchestrator turns into a degraded passthrough:
 *   2 = library not importable, 1 = compress() raised (e.g. weights not cached
 *   while offline), 3 = empty output (never blank out a non-empty spill).
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
  // compress_user_messages=True + protect_recent=0: by default Headroom protects
  // the latest message and recent context, so a single user message would be left
  // uncompressed. We hand it ONE message and want THAT compressed, so opt in.
  "    result = compress([{'role': 'user', 'content': text}], model=model, compress_user_messages=True, protect_recent=0)",
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
 * `OTTO_HEADROOM_PYTHON`; inference is local (no API key) and runs with
 * `HF_HUB_OFFLINE=1` by default, so first use needs pre-cached model weights.
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
          // Run offline by DEFAULT (#192): the ML model is a one-time Hugging Face
          // download Otto cannot proxy/gate and that would blow `timeoutMs` mid-run.
          // Forcing HF_HUB_OFFLINE means a governed run never performs that fetch —
          // it uses pre-cached weights or degrades cleanly. Respect an explicit
          // value (set HF_HUB_OFFLINE=0 to allow the in-run download).
          env: { ...env, HF_HUB_OFFLINE: env.HF_HUB_OFFLINE ?? "1" },
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
      "Context compressor (Headroom library mode): compresses token-heavy @spill content via headroom-ai's local compress() (needs the `[ml]` extra; `model` only selects the tokenizer, no API key). First use downloads the kompress-base model (~260–600 MB) from Hugging Face — pre-warm it (see docs/INTEGRATIONS.md §4).",
    capabilities: ["compression", "context-engineering"],
    stages: [],
    command: "python3 -c 'from headroom import compress'",
    env: [
      "OTTO_HEADROOM_BIN",
      "OTTO_HEADROOM_PYTHON",
      "HEADROOM_MODEL",
      "HF_HUB_OFFLINE",
      "HF_ENDPOINT",
    ],
    // The ML compressor fetches the kompress-base weights from Hugging Face on
    // first use. Declared here for an honest inventory, but Otto does NOT proxy the
    // subprocess, so this is not runtime-enforced — pre-download + HF_HUB_OFFLINE=1
    // (or an HF_ENDPOINT mirror) to keep a run offline (docs/INTEGRATIONS.md §4).
    networkDomains: [...HF_DEFAULT_DOMAINS],
    writeRoots: [],
    secretRefs: [],
    approvalActions: [],
    timeoutMs: 30_000,
    // Mirror runtime resolution (#192 part 3) cross-platform: a `node -e` probe
    // (node is always present — Otto is a Node CLI) honors the same env a run does
    // — `$OTTO_HEADROOM_BIN --version` in command mode, else the (overridable)
    // interpreter's `import headroom`. No POSIX shell builtins, so it works under
    // cmd.exe too (the prior `if [ … ]` form did not).
    healthCheck: `node -e "const{execFileSync}=require('child_process');const b=process.env.OTTO_HEADROOM_BIN;try{execFileSync(b||process.env.OTTO_HEADROOM_PYTHON||'python3',b?['--version']:['-c','import headroom'],{stdio:'ignore'})}catch(e){process.exit(1)}"`,
    enabled: true,
  };
}

/**
 * Every command a run could ACTUALLY execute, resolved from env exactly as
 * {@link resolveHeadroomRunner} does — so policy authorizes what runs, not a
 * static placeholder (issue #192 part 2 follow-up). Command mode emits one entry
 * **per category** (`<bin> compress --category <c>`), matching the real argv, so
 * an argument-specific `blockedCommands` pattern (e.g. `--category command-log`)
 * cannot slip past. Library mode is a single `<python> -c <bridge>` (the bridge
 * text carries `headroom`, so a pattern can match the interpreter or the library).
 */
export function headroomCommands(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const bin = env.OTTO_HEADROOM_BIN;
  if (typeof bin === "string" && bin.length > 0) {
    return COMPRESSION_CATEGORIES.map((c) => `${bin} compress --category ${c}`);
  }
  return [`${pythonBin(env)} -c ${HEADROOM_BRIDGE}`];
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
 * - any command that WOULD RUN ({@link headroomCommands}, resolved from `env` like
 *   the runtime — one per category in command mode, with `--category <c>`) blocked
 *   by `.otto/policy.json` → denied, with the blocked {@link SafetyEvent}s for the
 *   evidence bundle. Authorizing the resolved commands (not the static
 *   `tool.command`) closes the gap where `OTTO_HEADROOM_BIN` pointed at a
 *   policy-blocked binary, or an argument-specific pattern, that authorization
 *   never saw;
 * - in **library mode** only, when the run is **not** offline (the user set an
 *   online `HF_HUB_OFFLINE`, opting into the in-run model download), the **resolved**
 *   endpoint ({@link headroomNetworkDomains}, honoring `HF_ENDPOINT`) is authorized
 *   against the repo's `allowedNetworkDomains` — so a network-restricted repo denies
 *   the compressor rather than letting it reach an ungoverned host. Offline (the
 *   default) reaches no network; command mode (a custom `OTTO_HEADROOM_BIN`) does
 *   not use the Python library, so neither triggers the HF check.
 *
 * Pure: the registry, config, policy, and `env` are injected (the loop passes the
 * process env). Default policy + no override always allows.
 */
export function authorizeCompressor(
  tools: ToolDefinition[],
  config: ToolConfig,
  policy: SafetyPolicy,
  env: NodeJS.ProcessEnv = process.env
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
  // Authorize every command the run could execute (per-category in command mode);
  // deny if ANY is blocked, aggregating the events.
  const events: SafetyEvent[] = [];
  const kinds = new Set<string>();
  for (const command of headroomCommands(env)) {
    const auth = authorizeToolInvocation(policy, tool, { command });
    if (!auth.allowed) {
      events.push(...auth.events);
      for (const v of auth.violations) kinds.add(v.kind);
    }
  }
  // Library mode only: when the run opts OUT of offline mode it may fetch the model
  // from Hugging Face — authorize the RESOLVED endpoint (honoring HF_ENDPOINT)
  // against repo policy so a restricted repo denies it. Command mode (a custom
  // OTTO_HEADROOM_BIN) bypasses the Python library, so the HF check doesn't apply.
  const libraryMode = !(
    typeof env.OTTO_HEADROOM_BIN === "string" &&
    env.OTTO_HEADROOM_BIN.length > 0
  );
  if (libraryMode && !headroomOffline(env)) {
    const resolved = headroomNetworkDomains(env);
    // Scope the tool to the resolved endpoint so the gate is the repo policy
    // (tool-scope check becomes a no-op rather than a stale-list false denial).
    const net = authorizeToolInvocation(
      policy,
      { ...tool, networkDomains: resolved },
      { domains: resolved }
    );
    if (!net.allowed) {
      events.push(...net.events);
      for (const v of net.violations) kinds.add(v.kind);
    }
  }
  if (events.length > 0) {
    return {
      allowed: false,
      reason: `headroom tool command blocked by policy (${[...kinds].join(", ")})`,
      events,
    };
  }
  return {
    allowed: true,
    reason: "authorized by registry + policy",
    events: [],
  };
}
