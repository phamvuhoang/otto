import type { ProgressSignals } from "./progress.js";

/**
 * The adaptive compute router's early-stop / escalation policy (issue #41).
 * Pure: maps the current {@link ProgressSignals} plus a small running
 * {@link PolicyContext} to a {@link PolicyDecision}. No I/O, no model calls.
 * Inert until a later task feeds it into the loop behind an off-by-default flag.
 */

/** What the router should do after the current iteration. */
export type PolicyAction =
  /** Keep iterating — the run is making progress. */
  | "continue"
  /** Marginal progress is too low; stop and report rather than burn budget. */
  | "stop-low-progress"
  /** A repeated failure needs a human decision; pause with a report. */
  | "escalate-pause"
  /** Checks are green; short-circuit to a confident finish/verify. */
  | "finish-confident";

/** A policy action plus the signal that justified it. */
export type PolicyDecision = { action: PolicyAction; reason: string };

/** Running counters the policy needs beyond a single iteration's signals. */
export type PolicyContext = {
  /** Consecutive iterations (incl. this one) whose diff did not change. */
  stalledIterations: number;
  /** Consecutive iterations (incl. this one) with the same failure signature. */
  repeatedFailureStreak: number;
  /** Absolute failing checks this iteration, or `null` when not measured.
   *
   *  **The loop deliberately holds this at `null`** (P28 spec D1). Supplying a
   *  real count arms the `finish-confident` branch below, which `loop.ts` maps
   *  to exit reason "complete" followed by `return outcome()` — it ENDS the run,
   *  with no verify stage and no consultation of the gate that decides whether
   *  tasks remain. Because the field has always been null, that branch has never
   *  executed in production. See `docs/superpowers/specs/2026-07-30-p28-*.md`. */
  failingChecks: number | null;
  /** Findings raised in this iteration that were also raised in an earlier one
   *  (P28). Absent ⇒ 0 ⇒ every pre-P28 call site behaves exactly as before. */
  recurringFindingCount?: number;
};

/** Same failure this many iterations running → a human should look. */
const REPEATED_FAILURE_LIMIT = 3;
/** Diff unchanged this many iterations without improvement → stop. */
const STALL_LIMIT = 2;

/**
 * Decide what to do after an iteration. Precedence: a repeated failure that
 * needs a human (escalate) outranks a confident green finish, which outranks an
 * unproductive stall (stop), which outranks the default (continue). Pure.
 */
export function decide(
  signals: ProgressSignals,
  ctx: PolicyContext
): PolicyDecision {
  if (ctx.repeatedFailureStreak >= REPEATED_FAILURE_LIMIT) {
    return {
      action: "escalate-pause",
      reason: `same failure ${ctx.repeatedFailureStreak} iterations running — human decision needed`,
    };
  }

  // A defect that was fixed and came back needs a human, and a green suite does
  // NOT clear it — so this outranks `finish-confident` below. (Under D1 that
  // branch is unreachable anyway, but the ordering is stated so it stays correct
  // if the loop ever supplies a real `failingChecks`.)
  if ((ctx.recurringFindingCount ?? 0) > 0) {
    return {
      action: "escalate-pause",
      reason: `a fixed defect came back (${ctx.recurringFindingCount} recurring finding(s)) — human decision needed`,
    };
  }

  if (ctx.failingChecks === 0) {
    return {
      action: "finish-confident",
      reason: "checks are green — route to a confident finish/verify",
    };
  }

  const notImproving = signals.checksDelta == null || signals.checksDelta <= 0;
  if (ctx.stalledIterations >= STALL_LIMIT && notImproving) {
    return {
      action: "stop-low-progress",
      reason: `diff unchanged for ${ctx.stalledIterations} iterations with no check improvement`,
    };
  }

  return { action: "continue", reason: "run is making progress" };
}
