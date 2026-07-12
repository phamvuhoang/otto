import { describe, it, expect } from "vitest";
import {
  scopesOverlap,
  scopeConfidence,
  predictConflicts,
} from "../plan-tasks.js";

const T = (id: string, fileScope: string[]): any => ({
  id,
  title: id,
  fileScope,
  dependsOn: [],
  parallelSafe: true,
});

describe("scopesOverlap", () => {
  it("flags directory/prefix containment", () => {
    expect(scopesOverlap(["src/foo/a.ts"], ["src/foo/"])).toBe(true);
  });
  it("flags glob overlap", () => {
    expect(scopesOverlap(["src/foo/*.ts"], ["src/foo/a.ts"])).toBe(true);
  });
  it("returns false for disjoint scopes", () => {
    expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });
});

describe("scopeConfidence", () => {
  it("high when every scope path is in the plan map", () => {
    expect(
      scopeConfidence(T("t1", ["src/a.ts"]), ["src/a.ts", "src/b.ts"])
    ).toBe(1);
  });
  it("low when scope is ungrounded in the plan map", () => {
    expect(scopeConfidence(T("t1", ["src/ghost.ts"]), ["src/a.ts"])).toBe(0);
  });
  it("no penalty when no plan map exists", () => {
    expect(scopeConfidence(T("t1", ["src/a.ts"]), [])).toBe(1);
  });
});

describe("predictConflicts", () => {
  it("reports overlapping task ids and confidence", () => {
    const preds = predictConflicts(
      [T("t1", ["src/foo/a.ts"]), T("t2", ["src/foo/"])],
      ["src/foo/a.ts"]
    );
    expect(preds.find((p) => p.taskId === "t1")?.overlapsWith).toContain("t2");
  });
});
