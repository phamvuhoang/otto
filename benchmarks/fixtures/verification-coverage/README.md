# Fixture: verification-coverage (P24 / #181)

A **deterministic, no-model** eval for the roadmap's P24 metric — _"reports include
at least one verification artifact for tasks where a concrete artifact is
feasible"_ (% reports with a verification artifact) — proven in CI without a model
run.

The same three requirements are captured two ways:

- `unproven-matrix.json` — the verify stage asserts the tasks are DONE but cites
  **no artifacts** (and one outright failure). The coverage gate should **FAIL**
  and name the unproven/failed requirements.
- `proven-matrix.json` — every requirement carries a concrete artifact
  (`file:line`, a commit SHA, a suite command). Coverage is 100% and the gate
  should **PASS**.

The eval (`scripts/verification-coverage-eval.test.mjs`) asserts the gate
distinguishes them and that artifact coverage rises from the unproven matrix to
the proven one — the signal the roadmap's metric tracks.

The paid half (replaying `otto-afk --verify` against a real model and scoring the
authored matrix) is intentionally **not** run in CI, matching the rest of the
benchmark suite.
