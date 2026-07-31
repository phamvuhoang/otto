/**
 * Optional human checkpoint for the authored plan (issue #63 P8, slice 6).
 *
 * Renders the generated plan's rubric scorecard and asks the operator to approve,
 * edit, or reject it before implementation begins (the issue's "optional human
 * checkpoint", tying to the interactive approval-gate candidate). Otto runs AFK
 * (`claude --print`, non-interactive), so the checkpoint is OPT-IN and
 * record-and-proceed: when no human is present (non-interactive) the plan is
 * auto-approved and the decision is recorded, never blocking the run.
 *
 * Shipped as pure functions (`parseCheckpointResponse`, `formatCheckpointPrompt`)
 * plus a thin injectable resolver (`resolvePlanCheckpoint`) so it is fully
 * unit-testable with no real stdin/TTY. Wiring it into a live interactive run is
 * a follow-up; this is the substrate.
 */

import { formatPlanRubric, type PlanRubricScore } from "./plan-rubric.js";

/** The operator's decision at the checkpoint. */
export type CheckpointDecision = "approve" | "edit" | "reject";

/**
 * Map an operator's free-text response to a decision. Pure and lenient:
 * `y`/`yes`/`a`/`approve` → approve; `e`/`edit` → edit; everything else
 * (incl. empty, `n`, `no`) → reject. Rejecting is the safe default so an
 * ambiguous or empty answer never silently green-lights implementation.
 */
export function parseCheckpointResponse(raw: string): CheckpointDecision {
  const a = raw.trim().toLowerCase();
  if (a === "y" || a === "yes" || a === "a" || a === "approve")
    return "approve";
  if (a === "e" || a === "edit") return "edit";
  return "reject";
}

/** Render the checkpoint prompt: the rubric scorecard + the review question. */
export function formatCheckpointPrompt(opts: {
  taskKey: string;
  planPath: string;
  score: PlanRubricScore;
}): string {
  return [
    `Plan checkpoint — ${opts.taskKey}`,
    formatPlanRubric(opts.score),
    `Review the authored plan at ${opts.planPath}.`,
    "Approve this plan before implementation? [y]es / [e]dit / [N]o",
  ].join("\n");
}

/** Injectable host surface so the resolver needs no real stdin/TTY in tests. */
export type PlanCheckpointDeps = {
  /** Whether a human is present to answer (e.g. `process.stdin.isTTY`). */
  interactive: boolean;
  /**
   * Read one line of operator input; only called when `interactive`. Receives an
   * abort signal that fires when `timeoutMs` elapses so the underlying read can be
   * cancelled (otherwise an AFK run launched from a TTY blocks forever).
   */
  readLine: (signal?: AbortSignal) => Promise<string>;
  /**
   * Auto-approve if the operator does not answer within this window — an AFK run
   * may have a TTY but no human. `0`/omitted keeps the read open indefinitely.
   */
  timeoutMs?: number;
  out: (msg: string) => void;
};

/**
 * Print the checkpoint prompt and resolve the operator's decision. In a
 * non-interactive (AFK) run there is no human, so the plan is auto-approved and
 * the decision recorded — never blocking. Interactive runs read one line and
 * parse it via {@link parseCheckpointResponse}.
 */
export async function resolvePlanCheckpoint(
  prompt: string,
  deps: PlanCheckpointDeps
): Promise<CheckpointDecision> {
  deps.out(prompt);
  if (!deps.interactive) {
    deps.out(
      "Non-interactive run: plan auto-approved (record assumptions and proceed)."
    );
    return "approve";
  }
  const timeoutMs = deps.timeoutMs ?? 0;
  if (timeoutMs <= 0) {
    return parseCheckpointResponse(await deps.readLine());
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return parseCheckpointResponse(await deps.readLine(ac.signal));
  } catch (err) {
    if (ac.signal.aborted) {
      deps.out(
        `No response within ${Math.round(timeoutMs / 1000)}s — plan auto-approved (AFK fallback).`
      );
      return "approve";
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** What the loop does with the plan after the checkpoint resolves. */
export type PlanCheckpointOutcome = "accept" | "pause";

/** Host surface for the edit loop; extends the checkpoint's injectable reads. */
export type PlanEditLoopDeps = PlanCheckpointDeps & {
  /**
   * Auto-approve window for the INITIAL checkpoint only. The edit round uses
   * {@link editTimeoutMs}: once a human has taken control by choosing "edit",
   * silence must not be read as consent.
   */
  editTimeoutMs?: number;
};

/** Re-score the on-disk plan after the operator edited it. */
export type PlanEditLoopHooks = {
  rescore: () => Promise<{ passed: boolean; prompt: string }>;
  /** Cap on edit rounds so a loop cannot spin forever. Default 5. */
  maxRounds?: number;
};

const DEFAULT_EDIT_ROUNDS = 5;

/**
 * The working edit path (P31, issue #250).
 *
 * `loop.ts` previously did `decision === "approve" ? "accept" : "pause"`, so
 * `edit` and `reject` were indistinguishable: an operator who asked to edit got
 * the same dead end as one who rejected, and `parseCheckpointResponse`'s third
 * branch was unreachable in practice.
 *
 * Now "edit" pauses for on-disk edits to spec/plan, re-scores, shows the new
 * verdict, and asks again — a real edit-and-resubmit loop.
 *
 * Two deliberate asymmetries:
 *
 *  - **Human authority wins.** An explicit approve is accepted even if the
 *    re-score still fails. The verdict was shown; the operator outranks the
 *    heuristic.
 *  - **An edit-round timeout PAUSES rather than auto-approving.** The initial
 *    checkpoint auto-approves on silence because an AFK run may have a TTY and
 *    no human. Choosing "edit" is an explicit claim that a human is present, so
 *    silence afterwards means they walked away, not that they consented.
 */
export async function resolvePlanEditLoop(
  prompt: string,
  deps: PlanEditLoopDeps,
  hooks: PlanEditLoopHooks
): Promise<PlanCheckpointOutcome> {
  const maxRounds = hooks.maxRounds ?? DEFAULT_EDIT_ROUNDS;
  let current = prompt;
  for (let round = 0; round <= maxRounds; round++) {
    const decision = await resolvePlanCheckpoint(current, deps);
    if (decision === "approve") return "accept";
    if (decision === "reject") return "pause";
    // "edit": wait for on-disk edits, re-score, and ask again.
    if (round === maxRounds) {
      deps.out(
        `Reached the ${maxRounds}-edit limit without an approval — pausing for review.`
      );
      return "pause";
    }
    deps.out(
      "Edit `spec.md` / `plan.md` on disk, then press Enter to re-score them."
    );
    try {
      await readWithTimeout(deps, deps.editTimeoutMs ?? 0);
    } catch {
      deps.out("No response — pausing for review (edit was requested).");
      return "pause";
    }
    const rescored = await hooks.rescore();
    current = rescored.prompt;
  }
  return "pause";
}

/** Read one line, honoring an optional abort window. Rejects on timeout. */
async function readWithTimeout(
  deps: PlanCheckpointDeps,
  timeoutMs: number
): Promise<string> {
  if (timeoutMs <= 0) return deps.readLine();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await deps.readLine(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}
