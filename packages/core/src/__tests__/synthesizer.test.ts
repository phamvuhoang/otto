import { describe, it, expect } from "vitest";
import { orderByConflictRisk, buildCrossTaskSummary } from "../fanout.js";
import { predictConflicts } from "../plan-tasks.js";

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

  // P25 Task 3 regression guard: fanout.ts's Phase B previously called
  // `predictConflicts(wave, [])` unconditionally. A wave is already built
  // pairwise scope-disjoint by `planParallelGroups`, so `overlapsWith` is
  // always `[]` within it; with an empty plan file map `scopeConfidence` is
  // always `1` too — so the ordering was a uniform-score, stable no-op in
  // production. This proves a non-empty plan file map is what makes ordering
  // meaningful, and locks in that reverting to `[]` makes it inert again.
  it("orders scope-disjoint same-wave tasks by plan-map-grounded confidence, and ties when the map is empty", () => {
    const tasks = [T("weak", ["src/b.ts"]), T("strong", ["src/a.ts"])];

    // Only "src/a.ts" is grounded in the plan's file map: "strong" gets
    // confidence 1, "weak" gets confidence 0 — scopes remain disjoint
    // (no overlapsWith either way).
    const planFileMap = ["src/a.ts"];
    const predsGrounded = predictConflicts(tasks, planFileMap);
    expect(predsGrounded.find((p) => p.taskId === "strong")?.confidence).toBe(
      1
    );
    expect(predsGrounded.find((p) => p.taskId === "weak")?.confidence).toBe(0);
    expect(orderByConflictRisk(tasks, predsGrounded).map((t) => t.id)).toEqual([
      "strong",
      "weak",
    ]);

    // Empty map (fanout.ts's prior unconditional `[]`) reproduces uniform
    // confidence for every task — ordering degrades to a stable no-op that
    // preserves input order.
    const predsEmpty = predictConflicts(tasks, []);
    expect(predsEmpty.every((p) => p.confidence === 1)).toBe(true);
    expect(orderByConflictRisk(tasks, predsEmpty).map((t) => t.id)).toEqual([
      "weak",
      "strong",
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
