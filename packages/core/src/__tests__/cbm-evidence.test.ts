import { describe, it, expect } from "vitest";
import { summarizeGraphRetrieval } from "../context-compressor.js";
import type { ToolUsage } from "../run-report.js";

describe("summarizeGraphRetrieval", () => {
  it("undefined when no codebase-memory usage", () => {
    expect(
      summarizeGraphRetrieval([{ name: "headroom", kind: "command" }])
    ).toBeUndefined();
  });
  it("aggregates queries, tokens avoided, and fallbacks", () => {
    const usages: ToolUsage[] = [
      {
        name: "codebase-memory",
        kind: "mcp",
        tokensAvoided: 1200,
        query: "arch",
      },
      {
        name: "codebase-memory",
        kind: "mcp",
        tokensAvoided: 300,
        fallbackReason: "stale index",
      },
    ];
    expect(summarizeGraphRetrieval(usages)).toEqual({
      queries: 2,
      tokensAvoided: 1500,
      fallbacks: 1,
    });
  });
});
