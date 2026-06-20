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
- [ ] **2. Capture the rubric as an eval signal.** Surface the plan-completeness
  score next to the other run signals (extend `eval.ts` / the comparison surface
  or thread a `planQuality` onto the evidence bundle) so "plan-completeness rubric
  score ↑ across fixtures" is an actual measured signal. Pure; pinned by
  `eval`/`run-report` tests.
- [ ] **3. `otto-afk --plan-report` read-only surface.** A pure formatter that
  reads the persisted `.otto/tasks/<task-key>/{spec,plan}.md`, scores them with the
  rubric, and prints the scorecard (mirrors `--context-report`). Pinned by
  `cli-help.test.ts` + a cli test.
- [ ] **4. The `plan` stage — template + registry.** Add a `plan` stage to
  `STAGES` with a `plan.md` template that emits a spec + plan in the proven shape
  (problem → decisions → scope guard → file map → task-by-task steps with
  failing-test-first and explicit verify commands), persisting them under
  `.otto/tasks/<task-key>/`. Reuse the `superpowers.md` brainstorm philosophy;
  upgrade the template, not the philosophy. Pinned by a render-contract test.
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
