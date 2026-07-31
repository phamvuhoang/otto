import type { ChecksRecord } from "./checks.js";

/**
 * The adaptive compute router's progress-signal substrate (issue #41). Pure:
 * derives per-iteration progress from observations the loop already has (a diff
 * signature, failing-check count, dominant failure signature, reviewer finding
 * signatures, cumulative cost) — no I/O, no model calls. The policy layer
 * consumes these to decide whether to continue, stop, or escalate. Inert until
 * a later task wires it into the loop behind an off-by-default flag.
 */

/** What the loop observed at the end of one iteration. */
export type IterationObservation = {
  /** A stable signature (e.g. hash) of the working-tree diff this iteration. */
  diffSignature: string;
  /** Failing checks/tests observed, or `null` when not measured. */
  failingChecks: number | null;
  /** Signature of the dominant failure this iteration, or `null` when none. */
  failureSignature: string | null;
  /** Stable signatures of the reviewer findings raised this iteration. */
  findingSignatures: string[];
  /** Cumulative USD cost of the run through this iteration. */
  cumulativeCostUsd: number;
};

/** Per-iteration progress derived from the current and prior observations. */
export type ProgressSignals = {
  /** The diff differs from the prior iteration (always true on the first). */
  diffChanged: boolean;
  /** Failures removed since the prior iteration (positive = improving); `null`
   * when either side's failing-check count is unknown or there is no prior. */
  checksDelta: number | null;
  /** The same non-null failure signature recurred from the prior iteration. */
  repeatedFailure: boolean;
  /** Finding signatures present in both this and the prior iteration. */
  recurringFindings: string[];
  /** USD spent during this iteration alone (cost delta from the prior). */
  costBurnRateUsd: number;
};

/**
 * Derive {@link ProgressSignals} from the current iteration's observation and
 * the prior one (`undefined`/`null` on the first iteration). Pure.
 */
export function deriveProgress(
  cur: IterationObservation,
  prev?: IterationObservation | null
): ProgressSignals {
  if (prev == null) {
    return {
      diffChanged: true,
      checksDelta: null,
      repeatedFailure: false,
      recurringFindings: [],
      costBurnRateUsd: cur.cumulativeCostUsd,
    };
  }

  const checksDelta =
    cur.failingChecks == null || prev.failingChecks == null
      ? null
      : prev.failingChecks - cur.failingChecks;

  const repeatedFailure =
    cur.failureSignature != null &&
    cur.failureSignature === prev.failureSignature;

  const prevFindings = new Set(prev.findingSignatures);
  const recurringFindings = cur.findingSignatures.filter((f) =>
    prevFindings.has(f)
  );

  return {
    diffChanged: cur.diffSignature !== prev.diffSignature,
    checksDelta,
    repeatedFailure,
    recurringFindings,
    costBurnRateUsd: cur.cumulativeCostUsd - prev.cumulativeCostUsd,
  };
}

/**
 * The check-derived half of an {@link IterationObservation}, taken from P27's
 * harness-attested records rather than agent prose.
 */
export type CheckSignals = {
  failingChecks: number | null;
  failureSignature: string | null;
};

/**
 * Derive this iteration's check signals from the P27 records attested at its
 * boundaries (issue #248).
 *
 * **Feed this the ledger entries for the CURRENT iteration, never the run-level
 * `ChecksSummary`** (spec D2). That summary is terminal and cumulative:
 * `passed`/`failed` accumulate across the whole run, so a cumulative count can
 * never decrease and `checksDelta` would report improvement that never
 * happened. Per-boundary records are the only correct input here.
 *
 * No records ⇒ both `null`, which is exactly "unmeasured" — the value the loop
 * hardcoded before P28, so an unconfigured repo behaves as it always did. Pure.
 */
export function checkSignals(
  records: ChecksRecord[] | null | undefined
): CheckSignals {
  if (records == null || records.length === 0) {
    return { failingChecks: null, failureSignature: null };
  }
  const failed = records.filter((r) => r.exitCode !== 0);
  const first = failed[0];
  return {
    failingChecks: failed.length,
    failureSignature: first
      ? (first.failureSignature ?? `exit ${first.exitCode}`)
      : null,
  };
}

/**
 * Advance the consecutive-same-failure counter `decide` compares against
 * `REPEATED_FAILURE_LIMIT`.
 *
 * A green iteration resets it; a *different* failure restarts at 1 rather than
 * inheriting the previous defect's streak, so a fresh failure is never escalated
 * on another failure's history. Pure.
 */
export function nextFailureStreak(
  prevSignature: string | null,
  curSignature: string | null,
  prevStreak: number
): number {
  if (curSignature == null) return 0;
  return curSignature === prevSignature ? prevStreak + 1 : 1;
}
