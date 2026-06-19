# Fixture: rate-limit-resume (resilience)

Exercises the loop's rate-limit handling and resume path (`rate-limit.ts` /
`pacing.ts`): a run that hits a `429/529` should back off and continue rather
than corrupt its evidence bundle, and a re-run should pick up cleanly.

The underlying task is a small fix (`stack.mjs` `peek()` returns the wrong
element); the `tests` check (`node --test`) must pass once the run completes.

## Setup (manual/paid)

This scenario is non-deterministic — it depends on actually provoking a
throttle. Two ways to drive it:

- **Natural:** run during a period of API pressure with a low `--cooldown`.
- **Simulated:** point `OTTO_RUNNER=host` at a stub `claude` shim that emits an
  `is_error` result with `apiErrorStatus` `429` for the first stage, then a
  normal result on retry, and confirm the run still finalizes with
  `completedIterations` set and one stage record per stage (no duplicates).

Verify resilience with `otto-inspect latest`: the bundle should show the retried
stage once and a terminal exit reason.
