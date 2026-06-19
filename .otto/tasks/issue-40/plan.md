# Issue #40 — Implementation plan

Bite-sized, testable tasks. Deterministic-first; model-dependent runner last.
Check one off per run.

- [x] **1. Eval scoring substrate (`eval.ts`).** Pure `EvalSignals` type +
  `scoreTrajectory(manifest, stages)` deriving trajectory-only signals
  (succeeded, exitReason, completedIterations, stageCount, errorStageCount,
  costUsd, totalTokens, elapsedMs). Inert. Pinned by `eval.test.ts`.
  Verify: `pnpm -r typecheck && pnpm -r test` green; new tests pin every signal.
- [x] **2. Comparison report (`eval.ts` + formatter).** `compareTrajectories(
  labelled: {label, signals}[])` → a stable comparison table/string across
  configs (one row per labelled run, columns = signals; mark best/worst per
  signal). Pure. Pinned by tests.
  Verify: `pnpm -r typecheck && pnpm -r test` green; markdown table + best/worst
  markers + tie/single-run/null cases pinned in `eval.test.ts`.
- [x] **3. Benchmark task model.** A `BenchmarkTask` type + loader for a
  fixture manifest (id, kind, fixture path, the otto bin/args + env config to
  run, and the deterministic expected-outcome checks). Pure parsing + schema
  validation. Pinned by tests. No fixtures run yet.
- [x] **4. Fixture-derived signals.** Extend scoring with the checks that need
  the fixture repo, not just the trajectory: tests-passed (run the fixture's
  test cmd), diff-correctness (compare against a golden/assertion). Pinned by
  tests against a tiny in-repo fixture.
- [x] **5. `otto-eval` runner bin.** New bin replaying tasks across
  configurations by invoking the otto bins, collecting each run's evidence
  bundle, scoring, and emitting the comparison report. Injectable deps like
  `runInspect`/`runLinearAuth`. Pinned by tests with mocked run execution.
- [x] **6. Fixture repos/tasks.** The representative jobs from the issue: small
  bug fix w/ tests, multi-file feature, failing review repair, issue-intake
  triage, rate-limit/resume sim, prompt-injection-in-issue-body sim. Each a
  self-contained fixture + a benchmark task entry.
- [x] **7. CI cheap deterministic subset.** Wire the deterministic scoring +
  a no-model fixture subset into a `scripts/*.test.mjs` or a CI step so every
  roadmap initiative can add a benchmark before shipping.
- [ ] **8. Docs.** README + `docs/ARCHITECTURE.md` (+ roadmap status): the
  eval suite, `otto-eval` usage, how to add a benchmark, and the
  deterministic-vs-paid split. Doc-contract test if a drift risk emerges.

## Notes / dependencies

- Builds on the #39 evidence bundle (`run-report.ts`: `RunManifest`,
  `StageRecord`, `readManifest`/`readStageRecords`/`listRunIds`).
- Model-dependent replay (tasks 5–6, the paid suite) is never run in CI; CI
  runs only the deterministic scoring + comparison (tasks 1–2, 7).
