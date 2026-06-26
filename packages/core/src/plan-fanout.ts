/**
 * Decide whether a `--plan` run whose fan-out just landed implementation work
 * should review the aggregated diff instead of re-authoring the next plan.
 *
 * `--plan` is a one-shot authoring mode: its stage chain is `[plan]`, with no
 * reviewer. `--fan-out` runs first in the iteration and implements an existing
 * `tasks.json`. Combined, fan-out implements the prior slice and then the plan
 * stage authors the *next* slice (overwriting the slice docs in place), and the
 * fan-out diff is never reviewed — see issue #177.
 *
 * When fan-out actually landed work in a `--plan` run, the operator's intent was
 * to implement, not to re-plan. In that case the loop reviews the aggregated
 * fan-out diff and finalizes as an implementation run rather than re-planning.
 * This is gated on a reviewer stage being available — without one there is
 * nothing to substitute, so the run falls back to the normal plan chain.
 */
export function reviewsFanoutInsteadOfReplan(opts: {
  mode: string;
  fanOut: boolean;
  landed: number;
  hasReviewStage: boolean;
}): boolean {
  return (
    opts.mode === "plan" &&
    opts.fanOut &&
    opts.landed > 0 &&
    opts.hasReviewStage
  );
}
