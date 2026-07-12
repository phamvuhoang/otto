# Spec — P25: Multi-agent coordination hardening

Source roadmap: `docs/HARNESS_ROADMAP_PHASE5.md` §P25 (issue
[#182](https://github.com/phamvuhoang/otto/issues/182)). Epic
[#183](https://github.com/phamvuhoang/otto/issues/183).

**Opt-in under the existing `--fan-out` path. Non-fan-out runs are unchanged.**

## Problem

Otto's fan-out works but is naive at exactly the points that decide whether
parallel execution helps or hurts:

- **Conflict prediction is exact-string set disjointness on `fileScope`**
  (`plan-tasks.ts:140`). Two tasks touching `src/foo/a.ts` and `src/foo/` are
  treated as disjoint; a task whose declared scope is ungrounded in the plan runs
  as if trustworthy.
- **The "handoff" is one-way** — sub-agents receive `TASK_TITLE` + `TASK_SCOPE`
  and return **nothing structured** (`fanout.ts:81-104`). The synthesizer has no
  idea what actually changed, what tests ran, or what was touched out of scope.
- **Merge is naive in-array-order cherry-pick** (`fanout.ts:152-173`); conflicts
  are only discovered reactively at merge time.
- **Outcomes are invisible.** `FanoutTaskOutcome.reason` is printed to stderr and
  **never recorded** into the run bundle (`loop.ts:1154-1156`); sub-agents get no
  stage record. Reports cannot explain who did what or why a task was deferred.

The roadmap's thesis (§P25): coordination failure is a larger risk than raw
agent capability. Clear ownership, bounded context, handoff contracts, and
merge-risk prediction make fan-out lower wall-clock without raising conflict
churn. P25 is sequenced **last** because parallel execution multiplies weakness
in input quality (P23, done), retrieval isolation (P26), and merge clarity.

## Decisions (locked in brainstorming)

1. **Static conflict prediction only** — prefix/glob/directory overlap + a
   per-task confidence from reconciling `PlanTask.fileScope` against the plan's
   `extractPlanFileMap`. **No content/AST analysis** (stale-prone; arguably
   belongs with P26 retrieval).
2. **Structured handoff back** — sub-agents write a `handoff.json` the
   synthesizer reads and the report records.
3. **Evidence is the biggest win** — record sub-agent contributions and every
   defer reason into stage records + the manifest + the report.

## Scope

**In scope:**

- **Conflict prediction upgrade** (`plan-tasks.ts`):
  - Overlap by prefix/glob/directory, not exact string equality.
  - `scopeConfidence` per task by reconciling `PlanTask.fileScope` against
    `extractPlanFileMap` (`plan-rubric.ts:173`): scope ungrounded in the plan map
    ⇒ low confidence.
  - `planParallelGroups` defers low-confidence / overlapping tasks to sequential
    waves **with a recorded reason** ("split only when verification stays
    independent"). New `ConflictPrediction { taskId, overlapsWith, confidence,
reason }`. Deterministic and graceful-degrade (bad input ⇒ safe singleton
    waves), matching the current parser's throws-free contract.
- **Handoff contracts:**
  - `SubAgentHandoff { taskId, changedFiles, testsRun: {command, passed}[],
risks, deferred, outOfScopeFiles }`.
  - Sub-agents write `.otto-tmp/wt/<id>/handoff.json`; `outOfScopeFiles` computed
    by diffing actual changed files against declared `fileScope`.
  - `subImplementer` template (`templates/subtask.md`) updated to require it;
    parsing is throws-free (absent/garbage ⇒ a minimal handoff derived from the
    git diff, never a crash).
- **Smarter synthesizer** (`fanout.ts` Phase B):
  - Order merges lowest-conflict / highest-confidence first (from
    `ConflictPrediction` + handoff signals).
  - Defer risky merges with a specific reason (cherry-pick result + handoff).
  - Build a **cross-task interaction summary** (shared-file touches, out-of-scope
    touches, deferrals).
- **Cross-task summary → reviewer** (`panel.ts`): inject the summary as a bounded
  block before the lens phase (analogous to `formatSharpeningGuidance`), via a
  new optional `RunPanelOptions` field fed from `FanoutResult`. Inert when absent.
- **Specialist review binding:** route panel lenses by what fan-out touched
  (reuse `routedLenses` / `routeReview` / `classifyRisk`); include a PM lens when
  `pm-planning` is enabled. Mostly wiring existing pieces.
- **Evidence (the core gap):**
  - Record each sub-agent as a real stage record via `recordStage` (not only cost
    via `onSubAgent`/`accountStage`).
  - New optional `RunManifest` field (mirror `inputSharpness`) capturing per-agent
    contribution + every defer reason; enrich `FanoutTaskOutcome` with the
    handoff + reason.
  - New "Agent contributions" section in `finalizeReportText` (fed by a new
    `FinalizeReportContext` field).
- **P26 worktree-aware retrieval binding (optional):** thread the per-run
  retrieval/index identity (`runRetrievalStore`, `loop.ts:550`) into `runFanout`
  → sub-agents so one worktree cannot query another's stale graph. **Inert unless
  P26 is enabled** (guarded by the tool being active).

**Out of scope:**

- Content/AST conflict analysis; symbol/import graphs (defer to P26).
- Any change to sequential (non-fan-out) runs.
- Auto-splitting tasks the planner did not declare in `tasks.json` (Otto reads
  the graph the plan author wrote; P25 hardens execution, not generation).
- Automatic conflict _resolution_ — risky merges are deferred with a reason, not
  auto-resolved.

No new npm dependencies. ESM `.js` relative imports preserved.

## Testable success criteria

1. Overlap detection flags `src/foo/a.ts` vs `src/foo/` (prefix) and glob
   overlaps as conflicting; disjoint scopes stay parallel.
2. `scopeConfidence` is low for a task whose `fileScope` is absent from the plan
   file-map and high when grounded; `planParallelGroups` defers the low-confidence
   task to a singleton wave with a recorded reason.
3. Handoff parsing yields a valid `SubAgentHandoff` from good JSON, derives a
   minimal one (from a stub git diff) on missing/garbage input, and computes
   `outOfScopeFiles` correctly.
4. The synthesizer orders a two-task set lowest-conflict-first and defers the
   predicted-conflict task with the expected reason.
5. `finalizeReportText` renders an "Agent contributions" section listing each
   sub-agent's contribution and every defer reason from a fixture `FanoutResult`;
   the manifest carries the same structured field.
6. The cross-task interaction summary block is injected into the panel only when
   fan-out outcomes are present, and is absent otherwise.
7. Fan-out fixtures: disjoint tasks land (success), overlapping tasks are
   predicted + deferred with reason, an out-of-scope touch is surfaced in
   evidence. An A/B eval config records fan-out success / conflict-defer rate.

## Non-goals / risks

- **Do not parallelize unclear work.** Ownership or independently-verifiable
  scope in doubt ⇒ defer to sequential with a reason.
- **Do not silently resolve conflicts.** Deferral with a legible reason, not
  auto-merge.
- **Do not regress the throws-free contract.** Every new parser degrades to a
  safe default rather than aborting a run.
- **Keep P26 binding inert by default.** The worktree retrieval identity is only
  bound when P26 is active.

## Task outline (detailed in the plan)

1. `ConflictPrediction` + overlap detection + `scopeConfidence` (plan-map
   reconcile) in `plan-tasks.ts` (+ tests).
2. `SubAgentHandoff` type + throws-free parser + out-of-scope diff (+ tests);
   `subtask.md` template update.
3. Synthesizer: merge ordering + defer reasons + cross-task summary in
   `fanout.ts` (+ tests).
4. Evidence: sub-agent stage records + manifest field + `FanoutTaskOutcome`
   enrichment (+ tests).
5. Report: "Agent contributions" section in `finalizeReportText` (+ tests).
6. Panel: cross-task summary injection + lens routing binding (+ tests).
7. Optional P26 worktree retrieval-identity binding (inert by default) (+ test).
8. Fan-out A/B eval config + docs.
