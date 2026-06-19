import type { RunManifest, StageRecord } from "./run-report.js";
import { tokenUsageTotal } from "./tokens.js";

/**
 * The multi-signal outcome of one Otto run, derived purely from its recorded
 * trajectory (the #39 evidence bundle: a {@link RunManifest} plus its
 * {@link StageRecord}s). These are the signals that need no fixture re-run — the
 * deterministic, CI-runnable subset of the harness evaluation suite (issue #40).
 *
 * Fixture-dependent signals (tests passed, diff correctness, safety events) are
 * scored separately by the runner against a benchmark task's expected outcome.
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
  };
}

function elapsedMs(startedAt: string, finishedAt?: string): number | null {
  if (finishedAt == null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}
