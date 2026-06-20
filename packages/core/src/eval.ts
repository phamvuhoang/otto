import type { RunManifest, StageRecord } from "./run-report.js";
import { tokenUsageTotal } from "./tokens.js";

/**
 * The multi-signal outcome of one Otto run, derived purely from its recorded
 * trajectory (the #39 evidence bundle: a {@link RunManifest} plus its
 * {@link StageRecord}s). These are the signals that need no fixture re-run — the
 * deterministic, CI-runnable subset of the harness evaluation suite (issue #40).
 *
 * Fixture-dependent signals (tests passed, diff correctness) are scored
 * separately by the runner against a benchmark task's expected outcome. Safety
 * events are trajectory-derived — recorded into the bundle during the run — so
 * they are counted here.
 */
export type EvalSignals = {
  /** Run reached a success exit reason (`complete`/`done`). */
  succeeded: boolean;
  /** Terminal exit reason, or `null` for an un-finalized/interrupted run. */
  exitReason: string | null;
  /** Iterations completed, or `null` when the manifest is un-finalized. */
  completedIterations: number | null;
  /** Number of stage records in the trajectory. */
  stageCount: number;
  /** Stage records that ended in error. */
  errorStageCount: number;
  /** Total USD cost of the run. */
  costUsd: number;
  /** Sum of all token-usage fields for the run. */
  totalTokens: number;
  /** Wall-clock run duration in ms, or `null` when it cannot be computed. */
  elapsedMs: number | null;
  /** Safety events recorded across the manifest and stage records (issue #43). */
  safetyEventCount: number;
  /** Skills applied across the manifest and stage records (issue #44). */
  skillUsageCount: number;
};

const SUCCESS_REASONS = new Set(["complete", "done"]);

/**
 * Derive {@link EvalSignals} from a recorded run trajectory. Pure: no I/O, no
 * model calls — only arithmetic over the manifest and stage records, so it is
 * deterministic and unit-testable. `elapsedMs` is `null` when the run is
 * un-finalized (no `finishedAt`) or either timestamp is unparseable, never NaN.
 */
export function scoreTrajectory(
  manifest: RunManifest,
  stages: StageRecord[]
): EvalSignals {
  const exitReason = manifest.exitReason ?? null;
  return {
    succeeded: exitReason != null && SUCCESS_REASONS.has(exitReason),
    exitReason,
    completedIterations: manifest.completedIterations ?? null,
    stageCount: stages.length,
    errorStageCount: stages.filter((s) => s.isError).length,
    costUsd: manifest.costUsd,
    totalTokens: tokenUsageTotal(manifest.tokenUsage),
    elapsedMs: elapsedMs(manifest.startedAt, manifest.finishedAt),
    safetyEventCount:
      (manifest.safetyEvents?.length ?? 0) +
      stages.reduce((n, s) => n + (s.safetyEvents?.length ?? 0), 0),
    skillUsageCount:
      (manifest.skillsUsed?.length ?? 0) +
      stages.reduce((n, s) => n + (s.skillsUsed?.length ?? 0), 0),
  };
}

function elapsedMs(startedAt: string, finishedAt?: string): number | null {
  if (finishedAt == null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/** One Otto run's signals tagged with the configuration label that produced it. */
export type LabelledSignals = { label: string; signals: EvalSignals };

type CompareColumn = {
  header: string;
  cell: (s: EvalSignals) => string;
  /**
   * Directional signals are ranked across runs; `value` extracts the comparable
   * number (`null` runs are skipped) and `better` picks the winning direction.
   * Columns without `rank` are shown but never marked.
   */
  rank?: {
    value: (s: EvalSignals) => number | null;
    better: "higher" | "lower";
  };
};

const COMPARE_COLUMNS: CompareColumn[] = [
  {
    header: "Succeeded",
    cell: (s) => (s.succeeded ? "yes" : "no"),
    rank: { value: (s) => (s.succeeded ? 1 : 0), better: "higher" },
  },
  { header: "Exit", cell: (s) => s.exitReason ?? "—" },
  {
    header: "Iterations",
    cell: (s) => (s.completedIterations == null ? "—" : String(s.completedIterations)),
  },
  { header: "Stages", cell: (s) => String(s.stageCount) },
  {
    header: "Errors",
    cell: (s) => String(s.errorStageCount),
    rank: { value: (s) => s.errorStageCount, better: "lower" },
  },
  {
    header: "Cost (USD)",
    cell: (s) => `$${s.costUsd}`,
    rank: { value: (s) => s.costUsd, better: "lower" },
  },
  {
    header: "Tokens",
    cell: (s) => String(s.totalTokens),
    rank: { value: (s) => s.totalTokens, better: "lower" },
  },
  {
    header: "Elapsed (ms)",
    cell: (s) => (s.elapsedMs == null ? "—" : String(s.elapsedMs)),
    rank: { value: (s) => s.elapsedMs, better: "lower" },
  },
  // Shown but NOT ranked: a single count conflates blocked violations (bad) with
  // detected/reported injections (good detection), so there is no honest
  // direction to mark best/worst.
  { header: "Safety events", cell: (s) => String(s.safetyEventCount) },
  // Shown but NOT ranked: more skill reuse is usually good (less re-planning),
  // but a config can succeed with zero skills, so there is no honest best/worst.
  { header: "Skills used", cell: (s) => String(s.skillUsageCount) },
];

/**
 * Render a stable markdown comparison table across labelled runs — one row per
 * run, one column per {@link EvalSignals} field. Each directional signal (success
 * up; errors/cost/tokens/elapsed down) marks its best and worst cell, so a
 * maintainer can read a config A/B at a glance. Pure and deterministic. A column
 * is marked only when there is a spread across at least two comparable runs.
 */
export function compareTrajectories(runs: LabelledSignals[]): string {
  if (runs.length === 0) return "No runs to compare.";

  const extremes = COMPARE_COLUMNS.map((col) => {
    if (!col.rank || runs.length < 2) return null;
    const values = runs
      .map((r) => col.rank!.value(r.signals))
      .filter((v): v is number => v != null);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) return null;
    const higher = col.rank.better === "higher";
    return { best: higher ? max : min, worst: higher ? min : max };
  });

  const header = ["Run", ...COMPARE_COLUMNS.map((c) => c.header)];
  const rows = runs.map((r) => {
    const cells = COMPARE_COLUMNS.map((col, i) => {
      let cell = col.cell(r.signals);
      const ext = extremes[i];
      const value = col.rank?.value(r.signals);
      if (ext && value != null) {
        if (value === ext.best) cell += " (best)";
        else if (value === ext.worst) cell += " (worst)";
      }
      return cell;
    });
    return [r.label, ...cells];
  });

  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}
