import { describe, it, expect } from "vitest";
import { orderByConflictRisk, buildCrossTaskSummary } from "../fanout.js";

const T = (id: string, fileScope: string[]): any => ({
  id,
  title: id,
  fileScope,
  dependsOn: [],
  parallelSafe: true,
});

describe("orderByConflictRisk", () => {
  it("puts the highest-confidence, lowest-overlap task first", () => {
    const tasks = [T("risky", ["src/foo/"]), T("safe", ["src/z.ts"])];
    const preds = [
      { taskId: "risky", overlapsWith: ["safe"], confidence: 0.2 },
      { taskId: "safe", overlapsWith: [], confidence: 1 },
    ];
    expect(orderByConflictRisk(tasks, preds).map((t) => t.id)).toEqual([
      "safe",
      "risky",
    ]);
  });
});

describe("buildCrossTaskSummary", () => {
  it("summarizes out-of-scope touches and deferrals", () => {
    const s = buildCrossTaskSummary([
      {
        task: T("t1", ["src/a.ts"]),
        status: "landed",
        handoff: {
          taskId: "t1",
          changedFiles: ["src/a.ts", "src/x.ts"],
          testsRun: [],
          risks: [],
          deferred: [],
          outOfScopeFiles: ["src/x.ts"],
        },
      } as any,
      {
        task: T("t2", ["src/b.ts"]),
        status: "deferred",
        reason: "cherry-pick conflict",
      } as any,
    ]);
    expect(s).toContain("src/x.ts");
    expect(s).toContain("cherry-pick conflict");
  });
  it("returns empty when nothing noteworthy", () => {
    expect(
      buildCrossTaskSummary([
        { task: T("t1", ["src/a.ts"]), status: "landed" } as any,
      ])
    ).toBe("");
  });
});
