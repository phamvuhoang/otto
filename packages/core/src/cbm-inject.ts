import type {
  CbmRequest,
  CbmRunner,
  IndexFreshness,
} from "./codebase-memory-adapter.js";
import { canInject } from "./cbm-index.js";
import type { RetrievalStore } from "./context-compressor.js";
import type { ToolUsage } from "./run-report.js";

/**
 * Injection builder for the codebase-memory graph map (P26 slice2, Task 3).
 * Picks the {@link CbmRequest}s a stage needs ({@link stageQueries}), then
 * drives them through a {@link CbmRunner} and wraps the result in a bounded,
 * navigation-only `<graph-map>` block ({@link buildCbmInjection}). Injection
 * only happens when the index is `fresh` ({@link canInject}, Task 2) and every
 * query succeeds — anything else degrades to an empty block plus a
 * `fallbackReason` so the caller can record why nothing was injected. Pure
 * w.r.t. the injected `runner`/`store`; no filesystem or process access here.
 */
export const GRAPH_BLOCK_TAG = "graph-map";

const NAV_HEADER =
  "Code-navigation map (local graph index, may be stale). Read the actual " +
  "source before changing it; tests remain the gate.";

/**
 * The {@link CbmRequest}s a given stage should ask the codebase-memory index
 * for. `plan` wants the architecture overview; `implementer` searches the
 * graph for the task at hand; `reviewer`/`verifier` want change-impact
 * (detected changes + traced call paths) over the files that changed. Any
 * other stage gets no queries — injection is opt-in per stage, not global.
 */
export function stageQueries(
  stage: string,
  ctx: { changedFiles?: string[]; taskHint?: string }
): CbmRequest[] {
  switch (stage) {
    case "plan":
      return [{ operation: "get_architecture", params: {} }];
    case "implementer":
      return [
        { operation: "search_graph", params: { query: ctx.taskHint ?? "" } },
      ];
    case "reviewer":
    case "verifier":
      return [
        {
          operation: "detect_changes",
          params: { files: ctx.changedFiles ?? [] },
        },
        { operation: "trace_path", params: { files: ctx.changedFiles ?? [] } },
      ];
    default:
      return [];
  }
}

/** The rendered navigation-only block plus its evidence record. */
export type CbmInjection = { block: string; toolUsage: ToolUsage };

function usage(
  stage: string,
  freshness: IndexFreshness,
  over: Partial<ToolUsage>
): ToolUsage {
  return {
    name: "codebase-memory",
    kind: "mcp",
    stage,
    indexFreshness: freshness,
    ...over,
  };
}

/**
 * Runs `opts.requests` against `opts.runner` and, if the index is fresh and
 * every query succeeds, wraps the concatenated results in a bounded
 * `<graph-map>` block carrying the "read the actual source" navigation
 * header. The full (unbounded) result is handed to `opts.store` — when
 * provided — so a run report can retrieve it later via the returned
 * `retrievalHandle`; only the `maxChars`-bounded copy is actually injected
 * into the prompt. A non-fresh index, an empty request list, or any failed
 * call short-circuits to an empty block plus a `fallbackReason`. Always
 * returns a `ToolUsage` so the caller has evidence of the attempt either way.
 */
export function buildCbmInjection(opts: {
  stage: string;
  requests: CbmRequest[];
  runner: CbmRunner;
  freshness: IndexFreshness;
  maxChars: number;
  store?: RetrievalStore | null;
}): CbmInjection {
  const gate = canInject(opts.freshness);
  const query = opts.requests.map((r) => r.operation).join(",");
  if (!gate.inject || opts.requests.length === 0) {
    return {
      block: "",
      toolUsage: usage(opts.stage, opts.freshness, {
        query,
        fallbackReason: gate.fallbackReason ?? "no query for stage",
      }),
    };
  }
  const parts: string[] = [];
  for (const req of opts.requests) {
    const res = opts.runner.call(req);
    if (!res.ok) {
      return {
        block: "",
        toolUsage: usage(opts.stage, opts.freshness, {
          query,
          fallbackReason: `query failed: ${res.error ?? "unknown"}`,
        }),
      };
    }
    parts.push(
      typeof res.result === "string" ? res.result : JSON.stringify(res.result)
    );
  }
  const full = parts.join("\n");
  const handle = opts.store
    ? opts.store(`graph-map-${opts.stage}`, full)
    : undefined;
  const bounded =
    full.length > opts.maxChars ? `${full.slice(0, opts.maxChars)}…` : full;
  const block = `<${GRAPH_BLOCK_TAG}>\n${NAV_HEADER}\n\n${bounded}\n</${GRAPH_BLOCK_TAG}>`;
  return {
    block,
    toolUsage: usage(opts.stage, opts.freshness, {
      query,
      resultSize: full.length,
      retrievalHandle: handle,
    }),
  };
}
