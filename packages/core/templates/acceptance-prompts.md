<!--
  Per-mode human-acceptance prompts for the Otto quality report. Included ONCE by
  quality-report.md, so every run mode inherits the same set through the single
  existing contract include — never re-describe these per template (the same
  drift-proofing as the contract itself). The generic Human Acceptance Checklist
  stays; these add the task-fulfillment questions specific to the run's Mode.
-->

**Mode-specific acceptance prompts.** Beyond the generic checklist, fold the
prompts for **your Mode** (from Task Source) into the Human Acceptance Checklist.
Answer each with cited evidence, or mark it an explicit gap — never drop one
silently.

### afk — plan/PRD completion

- [ ] Every PRD acceptance criterion is met or explicitly deferred.
- [ ] All plan tasks are checked off, or the unchecked ones are recorded as gaps.
- [ ] The product behavior is demonstrable, not just coded.

### ghafk — GitHub issue burn-down

- [ ] The change resolves what the issue actually asked, not an adjacent reading.
- [ ] Work is scoped to this issue; unrelated changes are called out.
- [ ] The issue will close cleanly when the PR merges (PR/issue links cited).

### linear-afk — Linear issue burn-down

- [ ] The change resolves the Linear issue's stated intent.
- [ ] The comment cites the branch/PR and the explicit human next step.
- [ ] The issue is left in the correct state (OPEN for PR-based repos).

### apply-review — external review repair

- [ ] Every CONFIRMED finding was actually fixed, not just acknowledged.
- [ ] The fixes introduced no regression (suites re-run green).
- [ ] Deferred / rejected findings are recorded with a reason.

### verify — read-only verification

- [ ] Each task's claimed status matches committed reality (evidence cited).
- [ ] Suite results are current, not stale.
- [ ] Gaps and deferrals are honest, not optimistic.
