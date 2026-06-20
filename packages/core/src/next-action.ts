/**
 * Maps each end-of-run exit reason to a terse imperative hint telling the
 * maintainer what to do next. Extracted from loop.ts so `run-view.ts` can
 * import it without creating a loop ↔ run-view circular dependency.
 *
 * Pure and exported so it is unit-testable; unknown reasons fall back to a
 * generic hint rather than throwing.
 */
const NEXT_ACTION: Record<string, string> = {
  complete: "review the diff, then open a PR",
  done: "review the diff, then open a PR",
  "done with failures":
    "inspect the failed stage logs under `.otto-tmp/logs`, then re-run",
  "stopped (budget)": "raise `--budget` and re-run to resume",
  "halted (rate limit)": "re-run after the limit resets to resume",
  aborted: "re-run to resume from the saved iteration",
  "stopped (error)": "inspect the error above, then re-run",
  "stopped (low progress)":
    "the run stopped making changes — refine the plan/prompt, then re-run",
  "paused (needs human)":
    "a repeated failure needs a decision — inspect the logs, then re-run",
};

export function nextActionFor(reason: string): string {
  return NEXT_ACTION[reason] ?? "re-run to resume";
}
