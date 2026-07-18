# Spec — P31: Plan soundness and a working human loop

Source roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P31 ("Plan Soundness And A
Working Human Loop"). Largest phase-6 initiative — delivered in two slices;
slice 1 is fully planned in
`docs/superpowers/plans/2026-07-10-p31-plan-soundness.md`, slice 2 is outlined
there and planned after slice 1 lands.

**All opt-in. Default runs are byte-for-byte unchanged.**

## Problem

The plan gate judges shape, not substance, and the human checkpoint cannot
actually be used by a human. Verified against source (2026-07-10):

- **The gate is lexical-only and gameable.** `plan-rubric.ts` says it itself:
  the rubric judges "_structural completeness_ (does the plan have the sections
  a good plan has), the orthogonal question to the _semantic_ quality a
  human/model judges" (`plan-rubric.ts:17-22`). Every detector in
  `PLAN_CRITERIA` (`plan-rubric.ts:60-121`) and `scorePlanDepth`
  (`plan-rubric.ts:216-266`) is a header/keyword regex — a keyword-stuffed
  document containing "Problem", "assumptions", "out of scope", two backticked
  paths, two checkboxes with "failing test" + `verify:` and a "Success
  criteria … done when … test" line scores 8/8 rubric and 3/3 depth and sails
  through `assessPlanGate` (`plan-gate.ts:44-71`, thresholds 0.75 / 1 at
  `plan-gate.ts:18-19`). Meanwhile the plan template _asks_ for a self-played
  brainstorm that weighs options ("Prefer the simplest viable option",
  `templates/plan.md:55-62`) — and nothing verifies any option was ever weighed.
- **Edit collapses into reject.** `parseCheckpointResponse` parses `e`/`edit`
  (`plan-checkpoint.ts:28-34`) and the prompt offers it
  (`plan-checkpoint.ts:37-48`), but `handlePlanCompletion` maps every
  non-approve decision to pause: `decision === "approve" ? "accept" : "pause"`
  (`loop.ts:1063`). With a 2-minute auto-approve timer
  (`PLAN_CHECKPOINT_TIMEOUT_MS`, `loop.ts:136`;
  `plan-checkpoint.ts:89-103`) the human is a rubber stamp: they cannot fix a
  nearly-right plan, only kill the run.
- **One re-plan, then give up.** `planReplanUsed` is a boolean (`loop.ts:689`,
  `loop.ts:1034-1046`): a plan that fails the gate twice pauses, even though
  the model-tier ladder (`model-tier.ts:19-23`, `resolveStageModel`
  `model-tier.ts:132-152`) exists precisely to buy a stronger attempt.
- **Zero-path plans misfire as total drift.** `detectScopeDrift`
  (`plan-rubric.ts:292-314`) returns _every_ touched file as `outOfScope` when
  the plan names zero paths (`plan-rubric.ts:300-306`), so a plan whose only
  defect is a missing file map produces a false "scope drift flagged: N files"
  risk note in the report (`report-finalize.ts:92-97`) instead of the true
  finding — a plan coverage gap.
- **Sharpening never asks a present human.** `scoreInputSharpness` finds the
  unmet dimensions (`input-sharpness.ts:121-136`) but
  `formatSharpeningGuidance` is advisory-only and hardcodes "No human is
  available" (`input-sharpness.ts:147-165`) — even when the run is interactive
  by the same TTY test the checkpoint already performs (`loop.ts:998-1003`).
- **The gate is otto-afk-only.** `run-bin.ts:562-565` rejects `--plan` for
  ghafk/linear, so issue-driven runs get no plan gating at all.

## Goal

Gate plans on substance as well as shape, make the checkpoint's edit path a
real edit-resubmit loop, escalate once more before giving up, let sharpening
ask a present human, and make the spec → task → verification chain checkable —
all opt-in, with the judge fail-open so a broken judge never bricks a run.

## Decisions (locked in brainstorming)

1. **The judge is a harness-orchestrated substage, not a chain stage.** A local
   `Stage` const in `loop.ts` run via `executeStage` — the exact
   `REPORT_REWRITE_STAGE` pattern (`loop.ts:126-131`) and panel-lens pattern
   (`panel.ts:84-98`). Not in `STAGES`, not in any `*-main.ts` chain. Base
   tier `cheap` (roadmap: "cheap/mid-tier"); the ladder and pins behave as
   everywhere else (`resolveStageModel` pin-wins invariant,
   `model-tier.ts:141-142`).
2. **Lexical rubric stays as the fast pre-filter.** The judge runs **only** on
   plans that already pass the rubric + depth gate — a plan missing sections
   re-plans on regex evidence for free; model spend is reserved for plans that
   look right.
3. **The judge reads the document, not the repo.** Its template receives the
   spec+plan text and the extracted file map as rendered vars
   (`render.ts:211-215` generic `{{ VAR }}` substitution;
   `extractPlanFileMap`, `plan-rubric.ts:172-180`) and is instructed to use no
   tools. Roadmap non-goal: "the judge scores the plan document; it does not
   rewrite plans or browse the repo."
4. **Fail-open, recorded.** An unparseable verdict or a failed judge stage
   degrades to today's rubric-only gate with an `unavailable` reason recorded
   on the manifest — a broken judge must never block the opt-in plan flow.
5. **Judge joins the gate as an optional parameter.** `assessPlanGate` gains
   `opts.judge` / `opts.judgeThreshold` (default 2/3 — one soft dimension may
   miss, mirroring the 0.75 soft-threshold philosophy of
   `plan-gate.ts:14-18`). No judge result ⇒ verdicts byte-identical to today.
6. **Human authority wins at the checkpoint.** In the edit loop, an explicit
   approve is accepted even if the re-score still fails (the verdict was shown;
   the human outranks the heuristic). The edit loop's _timeout_ pauses — it
   never auto-approves, because the human explicitly took control by choosing
   edit. Timeout is generous (30 min) vs the checkpoint's 2.
7. **Escalated second re-plan = forced routing for that one attempt.** The plan
   stage's base tier is already `strong` (`stages.ts:19-24`), so tier _bumps_
   are a no-op; the real gap is that unrouted runs use the runtime default
   model. The final allowed re-plan therefore runs the plan stage with model
   routing forced on for that single `executeStage` call, so `strong` resolves
   through the ladder (default `opus`); an explicit model pin still wins.
   Capped at 2 re-plans total.
8. **Zero-path plans yield no drift verdict.** `detectScopeDrift` returns
   `outOfScope: []` + `fileMapMissing: true`; reports render "plan coverage
   gap — drift could not be assessed" instead of the false total-drift note.
9. **Slice split (the outline exceeds 9 tasks).** Slice 1: judge + edit path +
   re-plan counter + drift fix. Slice 2: interactive sharpening questions +
   plan-task-ID traceability + gate-everywhere. Slice 2 is spec'd here and
   outlined in the plan; its TDD plan is written after slice 1 lands.

## Scope

**In scope — slice 1:**

- `packages/core/src/plan-judge.ts` (new, pure + one injectable seam):
  - `PlanJudgeDimension` = `alternativesWeighed` (2+ approaches with a stated
    reason for the choice) | `riskSubstance` (failure modes / rollback / blast
    radius named concretely, not boilerplate) | `traceability` (every spec
    requirement maps to a task and a test).
  - `parsePlanJudgeVerdict(text)` — parses the structured
    `<dimension>: PASS|FAIL — reason` verdict lines into a `PlanJudgeScore`
    (shape mirrors `PlanRubricScore`); `null` unless all three dimensions are
    present (fail-open).
  - `formatPlanJudge(score)` — scorecard, mirroring `formatPlanRubric`.
  - `readPlanJudgeEnabled(workspaceDir, env, flag)` — `--plan-judge` →
    `OTTO_PLAN_JUDGE` → `.otto/config.json` `planJudge: true` → off
    (the `readCompressorMode` precedence pattern, `run-bin.ts:182-188`).
  - `runPlanJudge({ doc, fileMap, execute })` — orchestration behind an
    injectable executor so tests inject canned verdicts; the real executor is
    `executeStage` in `loop.ts`.
- `packages/core/templates/plan-judge.md` — document-only judging prompt with
  `{{ PLAN_DOC }}` / `{{ FILE_MAP }}` vars and the exact verdict-line contract.
- `assessPlanGate` gains optional `judge` + `judgeThreshold`
  (`DEFAULT_PLAN_JUDGE_THRESHOLD = 2/3`); `PlanGateVerdict` gains optional
  `judgeRatio`/`judgeThreshold`/`judgeMissing`; `formatPlanGate` renders the
  judge shortfall on failure. Backward compatible: no judge ⇒ today's verdict.
- Loop wiring: `PLAN_JUDGE_STAGE` local const (tier `cheap`); judge runs in
  `handlePlanCompletion` only when the lexical gate passed and the feature is
  enabled; verdict joins the gate, the checkpoint prompt shows
  `formatPlanJudge`, the substage is cost-accounted (`accountStage`) and
  evidence-recorded (`recordStage`); manifest gains an optional `planJudge`
  block (the `inputSharpness` optional-field pattern, `run-report.ts:178`,
  `loop.ts:850-856`).
- **Working edit path**: `resolvePlanEditLoop` in `plan-checkpoint.ts` — on
  "edit", print the `spec.md`/`plan.md` paths, wait for the human to edit on
  disk (re-prompt loop, own generous timeout `PLAN_EDIT_TIMEOUT_MS = 30 min`,
  bounded rounds), re-score (rubric + depth + judge) on resume via an injected
  `rescore`, then approve/edit-again/reject. Replaces the `"approve" : "pause"`
  collapse at `loop.ts:1063`. Timeout ⇒ pause.
- **Second re-plan at escalated tier**: `planReplanUsed` boolean →
  `planReplanCount` counter with a pure `planReplanDirective(count)` decision
  (`MAX_PLAN_REPLANS = 2`); the final re-plan forces model routing for the plan
  stage's next attempt (Decision 7).
- **Zero-path drift fix**: `ScopeDriftResult` + `ScopeDriftSummary` gain
  `fileMapMissing`; `detectScopeDrift` returns no drift verdict on zero-path
  plans; `report-finalize.ts` renders it as a coverage gap in the watch/
  uncertainty/evidence sections instead of total drift.
- Flags/docs: `--plan-judge` in `cli-help.ts` (+ help text), `run-bin.ts`
  resolution, `LoopOptions.planJudge`, README/`docs/CLI.md` rows, roadmap
  status line.

**In scope — slice 2 (spec'd now, planned after slice 1):**

- **Interactive sharpening questions**: when `--sharpen-input` finds unmet
  dimensions AND the session is interactive (the same TTY checks as the
  checkpoint, `loop.ts:998-1003`), ask up to 3 plan-changing questions before
  planning — one per unmet dimension (`input-sharpness.ts:46-94`), each
  skippable (Enter = skip), answers appended to the sharpening guidance as
  operator-provided dimensions. AFK unchanged: record assumptions and proceed.
  Never an interview tax: zero questions when the input is sharp.
- **Traceability**: plan-task IDs are already mandatory in `tasks.json`
  (`PlanTask.id`, `plan-tasks.ts:14-23`); `VerificationEntry` gains an optional
  `planTaskId` so P24 matrix rows cite the plan task they verify, the verify
  template asks for it, and the matrix summary reports plan-task coverage —
  spec → task → verification artifact becomes one checkable chain.
- **Gate everywhere**: give the ghafk/linear bin configs a `planStage`
  (issue-derived planning) so `--plan` stops being rejected at
  `run-bin.ts:562-565`; the plan-mode chain swap (`run-bin.ts:623-631`) and
  gate/checkpoint flow then apply as-is. Default bin behavior unchanged when
  the flag is absent.

**Out of scope:**

- The judge rewriting plans, browsing the repo, or running checks (P27 owns
  attested verify commands; when P27 lands the judge can _cite_ them — not
  re-execute them).
- Any default-on behavior: without `--plan`/`--plan-judge`/`--sharpen-input`
  the loop, prompts, and reports are byte-for-byte unchanged.
- Re-scoring on a cron/watcher during the edit loop (the human presses Enter;
  no fs-watch dependency).
- Judge memory/caching across runs; multi-judge panels.

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).
Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`.

## Testable success criteria

Pure/CI (must pass in `pnpm -r test`, no model calls — judge quality itself is
proven by the fixture pair + canned verdicts, not live inference):

1. A keyword-stuffed fixture plan scores 8/8 on `scorePlanQuality` and 3/3 on
   `scorePlanDepth` (proving lexical gameability), and a canned judge FAIL
   verdict parsed by `parsePlanJudgeVerdict` makes `assessPlanGate` fail it; a
   genuinely deep fixture with a canned all-PASS verdict passes both.
2. `parsePlanJudgeVerdict` round-trips PASS/FAIL + reasons for all three
   dimensions and returns `null` on a missing dimension or free-form prose.
3. `assessPlanGate` with no `judge` option returns verdicts deep-equal to
   today's for passing and failing scores (backward compatibility pinned).
4. `runPlanJudge` with a stubbed executor produces a scored outcome, and an
   executor that throws or emits garbage yields `score: null` + an
   `unavailable` reason (fail-open pinned).
5. `resolvePlanEditLoop`: edit → Enter → re-score → approve completes with
   "approve" (rescore called once); edit-again loops then reject; an
   unanswered window returns "timeout" (⇒ pause, never auto-approve); the
   round cap and the non-interactive guard both return "reject".
6. `planReplanDirective`: 0 used → plain re-plan; 1 used → escalated re-plan;
   2 used → pause.
7. `detectScopeDrift` on a zero-path plan returns `outOfScope: []` +
   `fileMapMissing: true` (existing path-named behavior unchanged), and the
   finalize report renders a coverage-gap sentence, not "scope drift flagged".
8. `parseFlags` parses `--plan-judge`; `readPlanJudgeEnabled` honors
   flag → env → config precedence and defaults off.

Slice 2 (criteria recorded now, tested in its own plan): interactive runs ask
at most 3 questions and only for unmet dimensions, AFK asks zero; matrix rows
carry `planTaskId` on gated runs and coverage is reported; `--plan` on
ghafk/linear gates the issue-derived plan while flag-absent runs are unchanged.

## Non-goals / risks

- **Do not turn the judge into a second implementer.** Document + file map in,
  three verdict lines out. No tools, no repo reads, no plan rewriting.
- **Do not let the judge brick planning.** Fail-open (Decision 4) — worst case
  is today's rubric-only gate, with the degradation recorded.
- **Do not make sharpening an interview tax.** Bounded (≤3), skippable, mapped
  1:1 to unmet dimensions, interactive-only; AFK keeps
  record-assumptions-and-proceed.
- **Do not auto-approve out of the edit loop.** A human who chose edit gets a
  pause on silence, not a green light.
- **Do not double model spend on every plan.** The judge runs cheap-tier, once
  per gate pass, and only behind `--plan-judge`.

## Task outline (slice 1 detailed in the plan)

Slice 1:

1. `plan-judge.ts` pure substrate: dimensions, `parsePlanJudgeVerdict`,
   `formatPlanJudge`, `readPlanJudgeEnabled` (+ tests).
2. `assessPlanGate` joins the judge verdict; `formatPlanGate` renders it
   (+ backward-compat tests).
3. `templates/plan-judge.md` + `runPlanJudge` behind an injectable executor
   (+ stuffed/deep fixture tests, fail-open tests).
4. Wiring: `--plan-judge` flag, `LoopOptions.planJudge`, `PLAN_JUDGE_STAGE`
   substage in `handlePlanCompletion`, manifest evidence (+ flag tests).
5. Working edit path: `resolvePlanEditLoop` + loop wiring replacing the
   `loop.ts:1063` collapse (+ tests).
6. Re-plan counter + escalated final attempt: `planReplanDirective` + loop
   wiring (+ tests).
7. Zero-path scope-drift fix + report rendering + docs + full verify.

Slice 2 (own plan after slice 1):

8. Interactive sharpening questions (bounded, skippable, TTY-gated).
9. Traceability: `VerificationEntry.planTaskId` + verify-template citation +
   matrix coverage reporting.
10. Gate everywhere: `planStage` for ghafk/linear bins behind the same
    `--plan` opt-in.
