import { describe, it, expect } from "vitest";
import { parseHandoff, computeOutOfScope } from "../handoff.js";

describe("computeOutOfScope", () => {
  it("flags a changed file outside declared scope", () => {
    expect(
      computeOutOfScope(["src/a.ts", "src/other.ts"], ["src/a.ts"])
    ).toEqual(["src/other.ts"]);
  });
  it("respects directory scope", () => {
    expect(computeOutOfScope(["src/foo/a.ts"], ["src/foo/"])).toEqual([]);
  });
  it("returns empty when no scope is declared", () => {
    expect(computeOutOfScope(["src/a.ts", "src/other.ts"], [])).toEqual([]);
  });
});

describe("parseHandoff", () => {
  it("normalizes valid JSON", () => {
    const h = parseHandoff(
      JSON.stringify({
        changedFiles: ["src/a.ts"],
        testsRun: [{ command: "pnpm test", passed: true }],
        risks: ["r"],
        deferred: [],
      }),
      "t1",
      []
    );
    expect(h.taskId).toBe("t1");
    expect(h.testsRun[0].passed).toBe(true);
  });
  it("derives a minimal handoff from the diff fallback on garbage", () => {
    const h = parseHandoff("not json", "t1", ["src/a.ts"]);
    expect(h.changedFiles).toEqual(["src/a.ts"]);
    expect(h.testsRun).toEqual([]);
  });
  it("never throws on null, arrays, or partially-typed fields", () => {
    expect(() => parseHandoff("null", "t1", ["src/a.ts"])).not.toThrow();
    expect(parseHandoff("null", "t1", ["src/a.ts"]).changedFiles).toEqual([
      "src/a.ts",
    ]);
    expect(() => parseHandoff("[1,2,3]", "t1", ["src/a.ts"])).not.toThrow();
    expect(parseHandoff("[1,2,3]", "t1", ["src/a.ts"]).changedFiles).toEqual([
      "src/a.ts",
    ]);
    const partial = parseHandoff(
      JSON.stringify({
        changedFiles: "not-an-array",
        testsRun: "nope",
        risks: 5,
      }),
      "t1",
      ["src/fallback.ts"]
    );
    expect(partial.changedFiles).toEqual(["src/fallback.ts"]);
    expect(partial.testsRun).toEqual([]);
    expect(partial.risks).toEqual([]);
  });
});
