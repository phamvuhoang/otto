/**
 * Semantic plan judge (P31, issue #250).
 *
 * The plan gate's rubrics are keyword/regex heuristics, so a plan can pass by
 * placing the right words in the right sections. The judge scores what those
 * cannot: were alternatives actually weighed, do the risks have substance, do
 * tests genuinely trace back to requirements.
 *
 * It runs ONLY on plans that already pass the lexical rubric, which stays as
 * the fast pre-filter — a plan missing whole sections re-plans on regex
 * evidence for free, and model spend is reserved for plans that look right.
 *
 * **Fail-open by design.** An unparseable verdict yields `null` and the gate
 * degrades to today's rubric-only decision. A broken judge must never be able
 * to block the opt-in plan flow.
 *
 * Pure except `readPlanJudgeEnabled`'s config read.
 * Spec: `docs/superpowers/specs/2026-07-10-p31-plan-soundness-design.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PlanJudgeDimension =
  | "alternativesWeighed"
  | "riskSubstance"
  | "traceability";

export const PLAN_JUDGE_DIMENSIONS: ReadonlyArray<{
  dimension: PlanJudgeDimension;
  label: string;
}> = [
  {
    dimension: "alternativesWeighed",
    label: "alternatives weighed, with a stated tradeoff",
  },
  {
    dimension: "riskSubstance",
    label: "risks named with a concrete rollback/mitigation",
  },
  {
    dimension: "traceability",
    label: "each requirement traces to a task and a test",
  },
];

export type PlanJudgeDimensionResult = {
  dimension: PlanJudgeDimension;
  label: string;
  met: boolean;
  reason: string;
};

/** Mirrors `PlanRubricScore` so the gate can treat both scores alike. */
export type PlanJudgeScore = {
  results: PlanJudgeDimensionResult[];
  metCount: number;
  maxScore: number;
  ratio: number;
  missing: string[];
};

/** `dimension: MET|UNMET | reason` — tolerant of surrounding prose and case. */
function verdictLine(
  text: string,
  dimension: PlanJudgeDimension
): { met: boolean; reason: string } | null {
  const re = new RegExp(
    `^\\s*${dimension}\\s*:\\s*(MET|UNMET)\\s*\\|?(.*)$`,
    "im"
  );
  const m = re.exec(text);
  if (!m) return null;
  return { met: m[1].toUpperCase() === "MET", reason: m[2].trim() };
}

/**
 * Parse the judge substage's verdict.
 *
 * Returns `null` unless **every** dimension has a verdict — a partial score
 * would be a silent downgrade of the gate rather than an honest abstention.
 */
export function parsePlanJudgeVerdict(text: string): PlanJudgeScore | null {
  const results: PlanJudgeDimensionResult[] = [];
  for (const { dimension, label } of PLAN_JUDGE_DIMENSIONS) {
    const v = verdictLine(text, dimension);
    if (!v) return null; // fail open
    results.push({ dimension, label, met: v.met, reason: v.reason });
  }
  const metCount = results.filter((r) => r.met).length;
  return {
    results,
    metCount,
    maxScore: results.length,
    ratio: results.length === 0 ? 0 : metCount / results.length,
    missing: results.filter((r) => !r.met).map((r) => r.dimension),
  };
}

/** Scorecard mirroring `formatPlanRubric`. */
export function formatPlanJudge(score: PlanJudgeScore): string {
  const head = `plan judge: ${score.metCount}/${score.maxScore} dimensions met`;
  const lines = score.results.map(
    (r) => `  ${r.met ? "✓" : "✗"} ${r.dimension} — ${r.reason || r.label}`
  );
  return [head, ...lines].join("\n");
}

/** Flag → `OTTO_PLAN_JUDGE` → `.otto/config.json` `planJudge` → false. */
export function readPlanJudgeEnabled(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  flag?: boolean
): boolean {
  if (flag === true) return true;
  const raw = env.OTTO_PLAN_JUDGE;
  if (raw !== undefined && raw !== "") return raw === "1" || raw === "true";
  try {
    const cfg = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    return cfg.planJudge === true;
  } catch {
    return false;
  }
}
