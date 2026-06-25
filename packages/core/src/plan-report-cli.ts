import { resolve } from "node:path";

import { assessPlanGate, formatPlanGate } from "./plan-gate.js";
import { readTaskPlanDocuments } from "./plan-artifacts.js";
import {
  formatPlanDepthRubric,
  formatPlanRubric,
  scorePlanDepth,
  scorePlanQuality,
  type PlanDepthScore,
  type PlanRubricScore,
} from "./plan-rubric.js";

/**
 * `otto-afk --plan-report` read-only surface (issue #63 P8, slice 3).
 *
 * A pure-then-I/O surface over the authored plans under `.otto/tasks/<key>/`:
 * it scores each task's `spec.md` + `plan.md` with the slice-1 plan-quality
 * rubric and prints the scorecard, mirroring `--context-report` / `otto-runs`.
 * Read-only; records nothing and runs no stage. The measurement the P8 `plan`
 * stage is judged against ("is the plan I authored structurally complete?").
 */

/** Injectable host surface so the bin stays unit-testable (mirrors `ContextReportDeps`). */
export type PlanReportDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: PlanReportDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

/** One task's authored plan and its rubric score. */
export type TaskPlanScore = {
  taskKey: string;
  score: PlanRubricScore;
  depth: PlanDepthScore;
};

/**
 * Render the per-task plan scorecards into one report. Pure: takes the already
 * read+scored tasks, returns the string. Tasks render in the given order
 * (callers pass them task-key sorted).
 */
export function formatPlanReport(tasks: TaskPlanScore[]): string {
  const lines: string[] = ["Plan report"];
  for (const t of tasks) {
    lines.push(
      "",
      `Task ${t.taskKey}`,
      formatPlanRubric(t.score),
      formatPlanDepthRubric(t.depth),
      formatPlanGate(assessPlanGate(t.score, { depth: t.depth }))
    );
  }
  return lines.join("\n");
}

/**
 * Read and score every task plan under `<workspaceDir>/.otto/tasks/`. A task is
 * any subdirectory holding a `spec.md` and/or `plan.md`; the two are scored
 * concatenated (the rubric criteria span both). I/O isolated here so
 * {@link formatPlanReport} stays pure. Absent/unreadable dir → `[]`.
 */
export function readTaskPlans(workspaceDir: string): TaskPlanScore[] {
  return readTaskPlanDocuments(workspaceDir).map((task) => ({
    taskKey: task.taskKey,
    score: scorePlanQuality(task.doc),
    depth: scorePlanDepth(task.doc),
  }));
}

/**
 * Drive `--plan-report`: score every authored task plan under `.otto/tasks/` and
 * print the scorecards. Read-only; resolves to the process exit code (1 only
 * when there is no plan to report on).
 */
export async function runPlanReport(
  deps: PlanReportDeps = defaultDeps
): Promise<number> {
  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  const tasks = readTaskPlans(workspaceDir);
  if (tasks.length === 0) {
    deps.err(
      `No task plans found under ${workspaceDir}/.otto/tasks/. ` +
        "Author a spec.md/plan.md there, then re-run with --plan-report."
    );
    return 1;
  }
  deps.out(formatPlanReport(tasks));
  return 0;
}
