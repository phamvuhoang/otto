# Plan — issue #63: P8 Spec & plan authoring

Ordered, bite-sized, testable tasks. One task per Otto run. The issue is Medium;
this burns it down rubric-first (measure plan quality before generating plans),
each slice gated on the prior, mirroring how #62 shipped pure substrate then
wired it.

- [ ] **1. Plan-quality rubric — pure scorer + formatter.** `plan-rubric.ts`:
  `scorePlanQuality(doc): PlanRubricScore` scores a spec/plan markdown document
  against eight criteria — problem, decisions/assumptions, scope guard, file map,
  task breakdown, failing-test-first, verify commands, testable success criteria
  — each a pure deterministic predicate (header/keyword heuristics, no model);
  returns per-criterion results, met-count / max score, a 0..1 `ratio`, and the
  `missing` list. `formatPlanRubric` renders a human-readable scorecard. Pure,
  INERT, exported from `index.ts`. Pinned by `plan-rubric.test.ts`.
- [x] **2. Capture the rubric as an eval signal.** Surfaced the plan-completeness
  score next to the other run signals: `EvalSignals.planQualityRatio` (0..1 or
  `null` when no plan scored), set by `scoreTrajectory(manifest, stages, {
  planScore })` — the caller passes the already-computed `PlanRubricScore` so the
  scorer stays pure (the rubric reads a document, not the trajectory). Added a
  higher-is-better "Plan quality" column to `compareTrajectories`. Pinned by
  `eval.test.ts`.
- [x] **3. `otto-afk --plan-report` read-only surface.** `plan-report-cli.ts`:
  `readTaskPlans(workspaceDir)` scores every `.otto/tasks/<key>/` (spec+plan
  concatenated) with the rubric; `formatPlanReport` (pure) renders a per-task
  scorecard; `runPlanReport` prints it and returns an exit code (1 when no plan).
  Flag wired in `cli-help.ts` + early-return in `run-bin.ts` (exit-code propagated,
  mirroring `--context-report`). Pinned by `plan-report-cli.test.ts`,
  `cli-help.test.ts`, `run-bin.test.ts`.
- [x] **4. The `plan` stage — template + registry.** Added `STAGES.plan` →
  `plan.md`, an authoring-only template (no implementation; writes only
  `.otto/tasks/<task-key>/{spec,plan}.md`) that reuses the autonomous-brainstorm
  philosophy and instructs the proven shape (problem → decisions → scope guard →
  file map → task-by-task failing-test-first + explicit verify commands),
  gate-compatible (emits `NO MORE TASKS` when already planned). Wiring it into a
  chain is slice 5, so it is inert on real runs for now. Pinned by
  `plan-stage.test.ts` (render-contract).
- [ ] **5. Wire the `plan` stage into the chain (opt-in).** Make the `plan` stage
  run before the implementer behind a flag (`--plan` / `OTTO_PLAN`), so an
  autonomous run can author the plan first; default off until proven. Pinned by a
  `run-bin` test.
- [ ] **6. Optional human checkpoint.** Render the generated plan and let the
  operator approve/edit before implementation begins (ties to the interactive
  approval-gate candidate); skipped in autonomous mode ("record assumptions and
  proceed"). Pinned by a checkpoint test.
- [ ] **7. Plan-quality gate / feedback.** Optionally re-plan when the rubric
  `ratio` is below a threshold (a self-healing plan loop), reporting the score and
  what was missing. Pinned by a loop test.

This run implements **task 1**.
