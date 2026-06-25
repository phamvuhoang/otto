import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_QUALITY_THRESHOLD,
  assessPlanGate,
  formatPlanGate,
} from "../plan-gate.js";
import type { PlanRubricScore } from "../plan-rubric.js";
import type { PlanDepthScore } from "../plan-rubric.js";

/** A rubric score with `met` of 8 criteria met (ratio = met/8). */
function score(met: number): PlanRubricScore {
  const maxScore = 8;
  return {
    results: [],
    metCount: met,
    maxScore,
    ratio: met / maxScore,
    missing: Array.from({ length: maxScore - met }, (_, i) => `crit${i}`),
  };
}

const shallowDepth: PlanDepthScore = {
  results: [],
  metCount: 2,
  maxScore: 3,
  ratio: 2 / 3,
  missing: ["Each task names a failing test and verify command"],
  fileMap: ["packages/core/src/foo.ts", "packages/core/src/foo.test.ts"],
};

describe("assessPlanGate", () => {
  it("passes at or above the default threshold", () => {
    const v = assessPlanGate(score(6)); // 6/8 = 0.75 == default
    expect(v.passed).toBe(true);
    expect(v.threshold).toBe(DEFAULT_PLAN_QUALITY_THRESHOLD);
    expect(v.shortfall).toBe(0);
  });

  it("fails below threshold and reports the shortfall + missing", () => {
    const v = assessPlanGate(score(4)); // 4/8 = 0.5
    expect(v.passed).toBe(false);
    // needs ceil(0.75*8)=6 met; has 4 → 2 more.
    expect(v.shortfall).toBe(2);
    expect(v.missing.length).toBe(4);
  });

  it("honors a custom threshold", () => {
    expect(assessPlanGate(score(8), { threshold: 1 }).passed).toBe(true);
    expect(assessPlanGate(score(7), { threshold: 1 }).passed).toBe(false);
    expect(assessPlanGate(score(0), { threshold: 0 }).passed).toBe(true);
  });

  it("fails a presence-complete plan when the P13 depth score is low", () => {
    const v = assessPlanGate(score(8), { depth: shallowDepth });
    expect(v.passed).toBe(false);
    expect(v.shortfall).toBe(0);
    expect(v.depthMissing).toEqual([
      "Each task names a failing test and verify command",
    ]);
  });
});

describe("formatPlanGate", () => {
  it("renders PASS without a re-plan note", () => {
    const out = formatPlanGate(assessPlanGate(score(8)));
    expect(out).toMatch(/plan gate: PASS/);
    expect(out).not.toMatch(/re-plan/);
  });

  it("renders FAIL with the shortfall and missing criteria", () => {
    const out = formatPlanGate(assessPlanGate(score(3)));
    expect(out).toMatch(/plan gate: FAIL/);
    expect(out).toMatch(/re-plan to add 3 more/);
  });

  it("renders depth shortfalls", () => {
    const out = formatPlanGate(
      assessPlanGate(score(8), { depth: shallowDepth })
    );
    expect(out).toMatch(/deepen plan/);
  });
});
