/**
 * Plan-quality gate (issue #63 P8, slice 7).
 *
 * Turns the slice-1 rubric score into a PASS/FAIL verdict against a soft quality
 * threshold and reports what a re-plan must add to clear the bar — the substrate
 * for a "self-healing plan" loop (re-plan when the score is too low) and the
 * `--plan-report` quality flag. Pure: takes a {@link PlanRubricScore}, returns the
 * verdict; triggers no re-plan itself (loop wiring is a follow-up).
 */

import type { PlanRubricScore } from "./plan-rubric.js";

/**
 * Default ratio a plan must reach to clear the gate. 0.75 = three-quarters of the
 * rubric criteria; tuned so a plan missing one or two sections still passes but a
 * thin plan (no scope guard, no tasks, no verify) does not.
 */
export const DEFAULT_PLAN_QUALITY_THRESHOLD = 0.75;

export type PlanGateVerdict = {
  passed: boolean;
  /** The plan's rubric ratio (0..1). */
  ratio: number;
  /** The threshold applied. */
  threshold: number;
  /** Labels of unmet criteria — what a re-plan must add. */
  missing: string[];
  /** Criteria still needed to reach the threshold; 0 when passed. */
  shortfall: number;
};

/**
 * Assess a rubric score against the quality threshold. A plan passes when its
 * ratio is at or above the threshold; otherwise `shortfall` is how many more
 * criteria it must meet to clear the bar (the re-plan target). Pure.
 */
export function assessPlanGate(
  score: PlanRubricScore,
  opts: { threshold?: number } = {}
): PlanGateVerdict {
  const threshold = opts.threshold ?? DEFAULT_PLAN_QUALITY_THRESHOLD;
  const passed = score.ratio >= threshold;
  const needed = Math.ceil(threshold * score.maxScore) - score.metCount;
  return {
    passed,
    ratio: score.ratio,
    threshold,
    missing: score.missing,
    shortfall: passed ? 0 : Math.max(0, needed),
  };
}

const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Render a gate verdict: a `PASS`/`FAIL` line with the ratio vs threshold, and —
 * on failure — what a re-plan must add to clear the bar.
 */
export function formatPlanGate(v: PlanGateVerdict): string {
  const head =
    `plan gate: ${v.passed ? "PASS" : "FAIL"} ` +
    `(${pct.format(v.ratio * 100)}% vs ${pct.format(v.threshold * 100)}% threshold)`;
  if (v.passed) return head;
  return (
    head +
    `\n  re-plan to add ${v.shortfall} more: ${v.missing.join(", ") || "—"}`
  );
}
