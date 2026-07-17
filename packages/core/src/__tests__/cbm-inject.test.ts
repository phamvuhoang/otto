import { describe, it, expect } from "vitest";
import {
  stageQueries,
  buildCbmInjection,
  GRAPH_BLOCK_TAG,
} from "../cbm-inject.js";
import type { CbmRunner } from "../codebase-memory-adapter.js";

const runner = (text: string): CbmRunner => ({
  available: () => true,
  call: () => ({ ok: true, result: text }),
});

describe("stageQueries", () => {
  it("asks for architecture on plan", () => {
    expect(stageQueries("plan", {}).map((r) => r.operation)).toEqual([
      "get_architecture",
    ]);
  });
  it("asks for change-impact on reviewer", () => {
    expect(
      stageQueries("reviewer", { changedFiles: ["src/a.ts"] }).map(
        (r) => r.operation
      )
    ).toEqual(["detect_changes", "trace_path"]);
  });
  it("returns nothing for an unknown stage", () => {
    expect(stageQueries("journalWrite", {})).toEqual([]);
  });
});

describe("buildCbmInjection", () => {
  const base = {
    stage: "plan",
    requests: [{ operation: "get_architecture", params: {} }],
    maxChars: 50,
  };

  it("injects a bounded navigation-only block when fresh", () => {
    const inj = buildCbmInjection({
      ...base,
      runner: runner("A".repeat(500)),
      freshness: "fresh",
    });
    expect(inj.block).toContain(`<${GRAPH_BLOCK_TAG}>`);
    expect(inj.block).toMatch(/read the actual source/i);
    expect(inj.block.length).toBeLessThan(200); // header + bounded 50-char body
    expect(inj.toolUsage.indexFreshness).toBe("fresh");
  });

  it("stores the full result and keeps a retrieval handle", () => {
    let stored = "";
    const store = (_k: string, original: string) => {
      stored = original;
      return ".otto/runs/r/compressed/graph-map.orig";
    };
    const inj = buildCbmInjection({
      ...base,
      runner: runner("FULL-RESULT"),
      freshness: "fresh",
      store,
    });
    expect(stored).toContain("FULL-RESULT");
    expect(inj.toolUsage.retrievalHandle).toContain("graph-map");
  });

  it("emits no block and a fallback reason when the index is not fresh", () => {
    const inj = buildCbmInjection({
      ...base,
      runner: runner("x"),
      freshness: "stale",
    });
    expect(inj.block).toBe("");
    expect(inj.toolUsage.fallbackReason).toMatch(/stale/);
  });

  it("emits no block and a fallback reason when a query fails", () => {
    const failing: CbmRunner = {
      available: () => true,
      call: () => ({ ok: false, error: "down" }),
    };
    const inj = buildCbmInjection({
      ...base,
      runner: failing,
      freshness: "fresh",
    });
    expect(inj.block).toBe("");
    expect(inj.toolUsage.fallbackReason).toMatch(/down|query/i);
  });
});
