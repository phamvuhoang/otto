import { describe, expect, it } from "vitest";

import {
  PLAN_CRITERIA,
  detectScopeDrift,
  extractPlanFileMap,
  formatPlanDepthRubric,
  formatPlanRubric,
  scorePlanDepth,
  scorePlanQuality,
  type PlanCriterion,
} from "../plan-rubric.js";

/** A plan that exercises every rubric criterion (the proven issue-62 shape). */
const COMPLETE_PLAN = [
  "# Plan — sample feature",
  "",
  "## Problem",
  "Users cannot export their data; this blocks the reporting workflow.",
  "",
  "## Decisions",
  "We assume the export is CSV-only for now. Rationale: cheapest correct path;",
  "a decision to defer XLSX until a customer asks.",
  "",
  "## Scope guard",
  "Out of scope: the admin UI. Non-goals: schema migrations.",
  "",
  "## File map",
  "- `packages/core/src/export.ts` — new pure module",
  "- `packages/core/src/__tests__/export.test.ts` — vitest pinning it",
  "",
  "## Tasks",
  "- [ ] 1. Write a failing test in packages/core/src/__tests__/export.test.ts for `toCsv`, then implement it.",
  "      verify: `pnpm -r test`",
  "- [ ] 2. Write a failing test in packages/core/src/__tests__/report.test.ts, then wire `toCsv` into the report bin.",
  "      verify: `pnpm -r typecheck`",
  "",
  "## Success criteria",
  "Done when: `toCsv` emits RFC-4180 output for every input; the test command passes and reviewers can check the expected output.",
  "Testing notes: vitest, pure.",
  "",
].join("\n");

/** A thin prompt-shaped doc with none of the rubric sections. */
const THIN_PLAN = "# Plan\n\nAdd the export thing and ship it.\n";

describe("scorePlanQuality", () => {
  it("scores a complete plan as fully met", () => {
    const score = scorePlanQuality(COMPLETE_PLAN);
    expect(score.maxScore).toBe(PLAN_CRITERIA.length);
    expect(score.metCount).toBe(PLAN_CRITERIA.length);
    expect(score.ratio).toBe(1);
    expect(score.missing).toEqual([]);
    expect(score.results.every((r) => r.met)).toBe(true);
  });

  it("scores a thin plan as mostly/entirely unmet", () => {
    const score = scorePlanQuality(THIN_PLAN);
    expect(score.metCount).toBe(0);
    expect(score.ratio).toBe(0);
    expect(score.missing).toHaveLength(PLAN_CRITERIA.length);
    expect(score.results.every((r) => !r.met)).toBe(true);
  });

  it("detects each criterion independently (neither always-true nor always-false)", () => {
    // Every criterion is met in COMPLETE and unmet in THIN — proves each
    // detector responds to its own section rather than firing constantly.
    const complete = scorePlanQuality(COMPLETE_PLAN);
    const thin = scorePlanQuality(THIN_PLAN);
    for (const c of PLAN_CRITERIA) {
      const id = c.criterion as PlanCriterion;
      expect(complete.results.find((r) => r.criterion === id)?.met).toBe(true);
      expect(thin.results.find((r) => r.criterion === id)?.met).toBe(false);
    }
  });

  it("reports a partial score with the missing criteria named", () => {
    const partial = [
      "## Problem",
      "The thing is broken.",
      "## Scope guard",
      "Non-goals: everything else.",
    ].join("\n");
    const score = scorePlanQuality(partial);
    expect(score.metCount).toBe(2);
    expect(score.ratio).toBeCloseTo(2 / PLAN_CRITERIA.length);
    // problem + scopeGuard met; the other six are missing.
    expect(score.missing.length).toBe(PLAN_CRITERIA.length - 2);
    expect(score.results.find((r) => r.criterion === "problem")?.met).toBe(
      true
    );
    expect(score.results.find((r) => r.criterion === "scopeGuard")?.met).toBe(
      true
    );
    expect(score.results.find((r) => r.criterion === "fileMap")?.met).toBe(
      false
    );
  });

  it("handles an empty / whitespace doc without throwing", () => {
    for (const doc of ["", "   \n\t  \n"]) {
      const score = scorePlanQuality(doc);
      expect(score.metCount).toBe(0);
      expect(score.ratio).toBe(0);
      expect(score.results).toHaveLength(PLAN_CRITERIA.length);
    }
  });
});

describe("scorePlanDepth", () => {
  it("scores a complete plan as deep", () => {
    const score = scorePlanDepth(COMPLETE_PLAN);
    expect(score.metCount).toBe(score.maxScore);
    expect(score.ratio).toBe(1);
    expect(score.fileMap).toContain("packages/core/src/export.ts");
  });

  it("requires real paths, named failing tests, verify commands, and testable success criteria", () => {
    const shallow = [
      "## File map",
      "- core stuff",
      "",
      "## Tasks",
      "- [ ] Add the thing.",
      "",
      "## Success criteria",
      "Make it good.",
    ].join("\n");
    const score = scorePlanDepth(shallow);
    expect(score.metCount).toBe(0);
    expect(score.missing).toEqual([
      "File map names at least two real paths",
      "Each task names a failing test and verify command",
      "Success criteria are concretely testable",
    ]);
  });

  it("extracts the file map and flags touched files outside it", () => {
    expect(extractPlanFileMap(COMPLETE_PLAN)).toEqual([
      "packages/core/src/__tests__/export.test.ts",
      "packages/core/src/export.ts",
    ]);
    const drift = detectScopeDrift(COMPLETE_PLAN, [
      "packages/core/src/export.ts",
      "packages/core/src/other.ts",
    ]);
    expect(drift.outOfScope).toEqual(["packages/core/src/other.ts"]);
  });

  it("formats a depth scorecard", () => {
    const out = formatPlanDepthRubric(scorePlanDepth(COMPLETE_PLAN));
    expect(out).toMatch(/plan depth/i);
    expect(out).toContain("100%");
  });
});

describe("formatPlanRubric", () => {
  it("renders a scorecard with the score and a per-criterion marker", () => {
    const out = formatPlanRubric(scorePlanQuality(COMPLETE_PLAN));
    expect(out).toMatch(/plan quality/i);
    expect(out).toContain(`${PLAN_CRITERIA.length}/${PLAN_CRITERIA.length}`);
    expect(out).toContain("100%");
    // every criterion label appears
    for (const c of PLAN_CRITERIA) expect(out).toContain(c.label);
  });

  it("names the missing criteria when the plan is incomplete", () => {
    const out = formatPlanRubric(scorePlanQuality(THIN_PLAN));
    expect(out).toMatch(/0\/8|0%/);
    expect(out).toMatch(/missing/i);
  });
});
