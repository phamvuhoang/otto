import { spawnSync } from "node:child_process";

import type {
  CompressInput,
  ContextCompressor,
  SyncContextCompressor,
} from "./context-compressor.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Headroom adapter (issue #112 P20) behind P19's external-tool contract.
 * [Headroom](https://github.com/headroomlabs-ai/headroom) compresses token-heavy
 * content (tool outputs, logs, RAG chunks, files, history). Otto talks to it as a
 * governed {@link ToolDefinition}, so the same registry/policy authority that
 * gates any tool gates the compressor — it can only run in allowed stages, with
 * the declared scope.
 *
 * This slice implements **local-first command mode** (the roadmap's preferred,
 * service-free path): Otto shells out to a local `headroom` binary, piping the
 * content on stdin and reading the compressed result on stdout. MCP mode and the
 * TypeScript library path slot in behind the same {@link ContextCompressor}
 * interface without changing callers; proxy/wrapper mode stays an explicit
 * advanced option because it alters provider transport.
 *
 * Everything is injectable ({@link HeadroomRunner}) so tests never spawn a real
 * process, and a missing binary degrades cleanly (the compressor reports
 * unavailable and the orchestrator keeps the original content).
 */

/** The default binary, overridable via `OTTO_HEADROOM_BIN`. */
export const HEADROOM_VERSION = "headroom-cmd-1";

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

/**
 * Default command-mode runner: `headroom --version` for availability, and
 * `headroom compress --category <c>` (content on stdin → compressed stdout) for
 * one compression. A non-zero exit / spawn error is a recoverable failure
 * (`ok: false`), which the orchestrator turns into a degraded passthrough.
 */
export function defaultHeadroomRunner(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000
): HeadroomRunner {
  const bin = headroomBin(env);
  return {
    available: () => {
      try {
        return spawnSync(bin, ["--version"], { timeout: 5_000 }).status === 0;
      } catch {
        return false;
      }
    },
    run: (input) => {
      const r = spawnSync(bin, ["compress", "--category", input.category], {
        input: input.text,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status !== 0 || typeof r.stdout !== "string") {
        return {
          ok: false,
          text: input.text,
          note: r.error?.message ?? `headroom exit ${r.status}`,
        };
      }
      return { ok: true, text: r.stdout };
    },
  };
}

/**
 * Build a {@link ContextCompressor} over a {@link HeadroomRunner}. Availability
 * is cached per instance after the first probe so a run does not re-spawn
 * `headroom --version` for every compression.
 */
export function createHeadroomCompressor(
  runner: HeadroomRunner = defaultHeadroomRunner()
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
  runner: HeadroomRunner = defaultHeadroomRunner()
): SyncContextCompressor {
  return {
    name: "headroom",
    version: HEADROOM_VERSION,
    available: runner.available(),
    compress: (input) => runner.run(input),
  };
}

/**
 * The {@link ToolDefinition} a repo drops into `.otto/tools/headroom.json` to put
 * the compressor under registry/policy authority. `stages: []` keeps it opt-in
 * (a repo enables it per stage); no network/write scope by default — local
 * command mode touches neither. Returned as a value so `otto-extensions`
 * (P21 `context-saver`) can generate it.
 */
export function headroomToolDefinition(): ToolDefinition {
  return {
    name: "headroom",
    kind: "command",
    description: "Local-first context compressor (Headroom command mode).",
    capabilities: ["compression", "context-engineering"],
    stages: [],
    command: "headroom compress",
    env: ["OTTO_HEADROOM_BIN"],
    networkDomains: [],
    writeRoots: [],
    secretRefs: [],
    approvalActions: [],
    timeoutMs: 30_000,
    healthCheck: "headroom --version",
    enabled: true,
  };
}
