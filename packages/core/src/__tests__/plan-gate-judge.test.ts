import { describe, expect, it } from "vitest";
import { assessPlanGate } from "../plan-gate.js";
import type { PlanRubricScore } from "../plan-rubric.js";
import { parsePlanJudgeVerdict } from "../plan-judge.js";

const rubric = (ratio: number): PlanRubricScore => ({
  results: [],
  metCount: Math.round(ratio * 8),
  maxScore: 8,
  ratio,
  missing: [],
});

const judge = (met: number) =>
  parsePlanJudgeVerdict(
    [
      `alternativesWeighed: ${met >= 1 ? "MET" : "UNMET"} | r`,
      `riskSubstance: ${met >= 2 ? "MET" : "UNMET"} | r`,
      `traceability: ${met >= 3 ? "MET" : "UNMET"} | r`,
    ].join("\n")
  )!;

describe("assessPlanGate with a judge score", () => {
  it("is byte-identical to today when no judge is supplied", () => {
    const withoutJudge = assessPlanGate(rubric(1));
    expect(withoutJudge.passed).toBe(true);
    expect(withoutJudge).not.toHaveProperty("judgeRatio");
  });

  it("passes when the plan clears both the rubric and the judge", () => {
    const v = assessPlanGate(rubric(1), { judge: judge(3) });
    expect(v.passed).toBe(true);
    expect(v.judgeRatio).toBeCloseTo(1);
  });

  it("FAILS a keyword-stuffed plan that clears the rubric but not the judge", () => {
    // The whole point: the lexical rubric is satisfiable by placement, the
    // judge is not.
    const v = assessPlanGate(rubric(1), { judge: judge(1) });
    expect(v.passed).toBe(false);
    expect(v.judgeMissing).toContain("riskSubstance");
  });

  it("tolerates one soft miss at the default 2/3 threshold", () => {
    const v = assessPlanGate(rubric(1), { judge: judge(2) });
    expect(v.passed).toBe(true);
  });

  it("never RESCUES a plan the rubric already failed", () => {
    // The judge is an additional bar, not an alternative one.
    const v = assessPlanGate(rubric(0.25), { judge: judge(3) });
    expect(v.passed).toBe(false);
  });

  it("honors an explicit judgeThreshold", () => {
    expect(
      assessPlanGate(rubric(1), { judge: judge(2), judgeThreshold: 1 }).passed
    ).toBe(false);
  });
});
