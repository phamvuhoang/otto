import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { estimateTokens } from "./context-report.js";
import { runReportDir } from "./run-report.js";
import type { ToolUsage } from "./run-report.js";

/**
 * Context compression at a governed harness boundary (issue #112 P20). Long
 * unattended runs are constrained by token spend (P7); a compressor such as
 * [Headroom](https://github.com/headroomlabs-ai/headroom) can shrink token-heavy
 * content before it reaches the model. P20 routes selected content through a
 * compressor and **measures** the result, with two hard rules from the roadmap:
 *
 * 1. **Off by default, degrades cleanly.** No compressor unless explicitly
 *    enabled (`--context-compressor headroom` / `OTTO_CONTEXT_COMPRESSOR` /
 *    `.otto/config.json` `contextCompressor`). A missing/failed compressor falls
 *    back to the original content with a warning — never a broken run.
 * 2. **Reversible, never hides evidence.** Every compression stores the original
 *    under a durable retrieval handle and records tokens before/after, latency,
 *    and the compressor version, so reports/evals/reviewers can still reach the
 *    original.
 *
 * The compressor is invoked behind P19's external-tool contract (see
 * `headroom-adapter.ts`); this module is the transport-agnostic core: setting
 * resolution, the `ContextCompressor` interface, the reversible-compress
 * orchestrator, and the savings summary. Pure except for the fs retrieval store,
 * which is injected.
 *
 * **Scope of this slice (P20a spike):** the setting, contract, adapter,
 * reversible mechanism, and inspectability are wired and tested. Applying
 * compression at every live spill/log/memory call site is the P20 production
 * follow-up — until then a run with the compressor off behaves exactly as today.
 */

/** Off, or route through the Headroom adapter. */
export type CompressorMode = "off" | "headroom";

const MODES: ReadonlySet<string> = new Set(["off", "headroom"]);

/**
 * The token-heavy content categories P7 already flags — the targets the roadmap
 * names. Carried on each compression so a report can attribute savings by source.
 */
export const COMPRESSION_CATEGORIES = [
  "issue-body",
  "command-log",
  "prior-iteration",
  "read-artifact",
  "memory-projection",
] as const;
export type CompressionCategory = (typeof COMPRESSION_CATEGORIES)[number];

/** Content handed to the compressor, tagged by source category + a stable key. */
export type CompressInput = {
  /** A run-unique key (used to name the retrieval artifact). */
  key: string;
  category: CompressionCategory;
  text: string;
};

/**
 * A compressor adapter (Headroom, or a test double). `compress` is async because
 * a real adapter shells out / calls a local MCP server. `ok: false` signals a
 * recoverable failure (the orchestrator then degrades to the original).
 */
export type ContextCompressor = {
  name: string;
  version: string;
  /** Whether the underlying tool is installed/reachable right now. */
  isAvailable: () => boolean | Promise<boolean>;
  compress: (
    input: CompressInput
  ) => Promise<{ text: string; ok: boolean; note?: string }>;
};

/**
 * A synchronous compressor for the sync render/`@spill` path. `available` is a
 * value (probed once when the compressor is built) rather than a call, since the
 * sync render boundary cannot await an availability check.
 */
export type SyncContextCompressor = {
  name: string;
  version: string;
  available: boolean;
  compress: (input: CompressInput) => {
    text: string;
    ok: boolean;
    note?: string;
  };
};

/** The measured outcome of one compression (or a degraded passthrough). */
export type CompressOutput = {
  /** The text to actually use downstream (compressed, or original if degraded). */
  text: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** Durable handle to the original; absent when nothing was stored (passthrough). */
  retrievalHandle?: string;
  latencyMs: number;
  compressorVersion: string;
  /** True when the compressor was unavailable/failed and the original was kept. */
  degraded: boolean;
  note?: string;
};

/**
 * Persist the original content and return a durable retrieval handle. Injected so
 * the orchestrator stays testable; {@link runRetrievalStore} is the fs default.
 */
export type RetrievalStore = (key: string, original: string) => string;

/**
 * Resolve the compressor mode from the flag/env/config precedence chain (flag >
 * env > config > off). An unrecognized value resolves to `off`, so a typo never
 * silently enables compression. Pure.
 */
export function resolveCompressorMode(opts: {
  flag?: string;
  env?: string;
  config?: string;
}): CompressorMode {
  for (const raw of [opts.flag, opts.env, opts.config]) {
    if (typeof raw === "string" && raw.length > 0) {
      const v = raw.trim().toLowerCase();
      return MODES.has(v) ? (v as CompressorMode) : "off";
    }
  }
  return "off";
}

/**
 * Read the effective compressor mode for a workspace: `--context-compressor`
 * flag, else `OTTO_CONTEXT_COMPRESSOR`, else `.otto/config.json`
 * `contextCompressor`, else `off`. Missing/malformed config → off (never throws).
 */
export function readCompressorMode(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  flag?: string
): CompressorMode {
  let config: string | undefined;
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    if (typeof raw.contextCompressor === "string")
      config = raw.contextCompressor;
  } catch {
    // no/invalid config → leave undefined (resolves to off)
  }
  return resolveCompressorMode({
    flag,
    env: env.OTTO_CONTEXT_COMPRESSOR,
    config,
  });
}

/**
 * Default fs retrieval store: write each original under
 * `.otto/runs/<run-id>/compressed/<key>.orig` and return that **workspace-relative**
 * path as the durable handle, so the run bundle stays portable.
 */
export function runRetrievalStore(
  workspaceDir: string,
  runId: string
): RetrievalStore {
  const absDir = join(runReportDir(workspaceDir, runId), "compressed");
  return (key, original) => {
    mkdirSync(absDir, { recursive: true });
    const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
    writeFileSync(join(absDir, `${safe}.orig`), original);
    return join(".otto", "runs", runId, "compressed", `${safe}.orig`);
  };
}

/** One compression attempt's raw result, before measurement/decision. */
type RawResult = { text: string; ok: boolean; note?: string };

/**
 * Turn a raw compression attempt into a measured {@link CompressOutput}, shared
 * by the async ({@link compressContent}) and sync ({@link compressContentSync})
 * entry points so their decision logic never drifts. `result === null` means the
 * compressor was unavailable (degraded passthrough). A result that did not shrink
 * the token estimate is discarded in favor of the original. Pure except for the
 * injected `store` (only invoked on a real reduction).
 */
function assembleOutput(
  input: CompressInput,
  version: string,
  result: RawResult | null,
  store: RetrievalStore | null,
  latencyMs: number
): CompressOutput {
  const tokensBefore = estimateTokens(input.text.length);
  const passthrough = (degraded: boolean, note?: string): CompressOutput => ({
    text: input.text,
    tokensBefore,
    tokensAfter: tokensBefore,
    tokensSaved: 0,
    latencyMs,
    compressorVersion: version,
    degraded,
    ...(note ? { note } : {}),
  });

  if (result === null) {
    return passthrough(
      true,
      `compressor "${version}" unavailable — kept original`
    );
  }
  const tokensAfter = estimateTokens(result.text.length);
  if (!result.ok || tokensAfter >= tokensBefore) {
    return passthrough(
      !result.ok,
      result.note ??
        (result.ok ? "no token reduction — kept original" : undefined)
    );
  }
  const retrievalHandle = store ? store(input.key, input.text) : undefined;
  return {
    text: result.text,
    tokensBefore,
    tokensAfter,
    tokensSaved: tokensBefore - tokensAfter,
    ...(retrievalHandle ? { retrievalHandle } : {}),
    latencyMs,
    compressorVersion: version,
    degraded: false,
    ...(result.note ? { note: result.note } : {}),
  };
}

/**
 * Compress one piece of content reversibly and measure it (async — for adapters
 * that shell out / call a local MCP server). The single entry point both a live
 * async caller and the benchmark use:
 *
 * - off (`compressor` null) → original verbatim, zero savings, not degraded;
 * - compressor unavailable / throws / `ok: false` → degraded passthrough
 *   (original kept), never throws;
 * - success → stores the original via `store`, returns compressed text + measured
 *   tokens-before/after, savings, retrieval handle, and latency.
 *
 * `now` is injected for deterministic latency in tests.
 */
export async function compressContent(
  compressor: ContextCompressor | null,
  input: CompressInput,
  store: RetrievalStore | null,
  deps: { now?: () => number } = {}
): Promise<CompressOutput> {
  const now = deps.now ?? Date.now;
  if (!compressor)
    return assembleOutput(
      input,
      "off",
      { ok: true, text: input.text },
      null,
      0
    );

  const start = now();
  let available: boolean;
  try {
    available = await compressor.isAvailable();
  } catch {
    available = false;
  }
  if (!available) return assembleOutput(input, compressor.name, null, store, 0);

  try {
    const result = await compressor.compress(input);
    return assembleOutput(
      input,
      compressor.version,
      result,
      store,
      Math.max(0, now() - start)
    );
  } catch (e) {
    return assembleOutput(
      input,
      compressor.version,
      {
        ok: false,
        text: input.text,
        note: `compressor error: ${(e as Error).message ?? e}`,
      },
      store,
      Math.max(0, now() - start)
    );
  }
}

/**
 * Synchronous compression for the sync render/`@spill` path, where `renderTemplate`
 * cannot await. Same reversible measurement and degrade rules as
 * {@link compressContent}; backed by a {@link SyncContextCompressor} (the Headroom
 * runner is synchronous — it drives `compress()` via a blocking subprocess).
 * `compressor === null` → original verbatim.
 */
export function compressContentSync(
  compressor: SyncContextCompressor | null,
  input: CompressInput,
  store: RetrievalStore | null,
  now: () => number = Date.now
): CompressOutput {
  if (!compressor)
    return assembleOutput(
      input,
      "off",
      { ok: true, text: input.text },
      null,
      0
    );
  if (!compressor.available)
    return assembleOutput(input, compressor.name, null, store, 0);
  const start = now();
  try {
    const result = compressor.compress(input);
    return assembleOutput(
      input,
      compressor.version,
      result,
      store,
      Math.max(0, now() - start)
    );
  } catch (e) {
    return assembleOutput(
      input,
      compressor.version,
      {
        ok: false,
        text: input.text,
        note: `compressor error: ${(e as Error).message ?? e}`,
      },
      store,
      Math.max(0, now() - start)
    );
  }
}

/**
 * Build the {@link ToolUsage} evidence record for a compression, so the loop can
 * attach it to a stage's `toolsUsed[]` (P19). Pure.
 */
export function compressionToolUsage(
  output: CompressOutput,
  category: CompressionCategory,
  stage?: string
): ToolUsage {
  return {
    name: "headroom",
    kind: "command",
    ...(stage ? { stage } : {}),
    tokensSaved: output.tokensSaved,
    ...(output.retrievalHandle
      ? { retrievalHandle: output.retrievalHandle }
      : {}),
    reasons: [
      `compressed ${category}`,
      output.degraded
        ? "degraded: kept original"
        : `saved ${output.tokensSaved} tokens`,
    ],
  };
}

/** Aggregate savings across a run's compressions (for the context report). */
export type CompressionSummary = {
  invocations: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  retrievals: number;
  degraded: number;
};

/** Sum a set of compression outcomes into a {@link CompressionSummary}. Pure. */
export function summarizeCompression(
  outputs: CompressOutput[]
): CompressionSummary {
  const s: CompressionSummary = {
    invocations: outputs.length,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    retrievals: 0,
    degraded: 0,
  };
  for (const o of outputs) {
    s.tokensBefore += o.tokensBefore;
    s.tokensAfter += o.tokensAfter;
    s.tokensSaved += o.tokensSaved;
    if (o.retrievalHandle) s.retrievals += 1;
    if (o.degraded) s.degraded += 1;
  }
  return s;
}

/**
 * Summarize the compression {@link ToolUsage} records on a run's stage records
 * (name `headroom`) — what `--context-report` reads, since the loop attaches
 * compression evidence as `toolsUsed[]`. Pure.
 */
export function summarizeToolCompression(usages: ToolUsage[]): {
  invocations: number;
  tokensSaved: number;
  retrievals: number;
} {
  let tokensSaved = 0;
  let retrievals = 0;
  let invocations = 0;
  for (const u of usages) {
    if (u.name !== "headroom") continue;
    invocations += 1;
    tokensSaved += u.tokensSaved ?? 0;
    if (u.retrievalHandle) retrievals += 1;
  }
  return { invocations, tokensSaved, retrievals };
}

/** One-line human summary of compression savings for the context report. Pure. */
export function formatCompressionSummary(s: CompressionSummary): string {
  if (s.invocations === 0) return "Context compression: not used.";
  const pct =
    s.tokensBefore > 0 ? Math.round((s.tokensSaved / s.tokensBefore) * 100) : 0;
  const parts = [
    `Context compression: ${s.tokensSaved} tokens saved (${pct}%) across ${s.invocations} call(s)`,
    `${s.retrievals} original(s) retained`,
  ];
  if (s.degraded > 0) parts.push(`${s.degraded} degraded (kept original)`);
  return parts.join("; ") + ".";
}
