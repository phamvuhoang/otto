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
  if (a === "y" || a === "yes" || a === "a" || a === "approve") return "approve";
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
  /** Read one line of operator input; only called when `interactive`. */
  readLine: () => Promise<string>;
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
  return parseCheckpointResponse(await deps.readLine());
}
