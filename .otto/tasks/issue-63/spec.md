# Spec — issue #63: P8 Spec & plan authoring

## Problem

Most failed or expensive Otto runs trace to **under-specified work**, not hard
code: a thin prompt yields a thin plan, the implementer flails, and the reviewer
generates rework commits. A good plan is far cheaper than re-doing code, and
fewer flailing iterations also cut tokens (reinforcing P7). Today the
brainstorm → spec → plan philosophy lives only as prose in the `superpowers.md`
playbook fragment; nothing in Otto **emits** a structured spec+plan as a first
class artifact, and nothing **measures** whether a plan is any good. P8's
outcome: from a thin prompt, Otto produces a rich, structured spec (problem,
decisions, scope-guard, component/file map, testing) and a task-decomposed plan
(per-task TDD + verification steps) — the quality of the `docs/superpowers`
examples — persisted under `.otto/tasks/<task-key>/` for human review before it
writes code.

## Approach

Burn the issue down **rubric-first**, mirroring how P7 (#62) shipped
telemetry-first: you cannot prove the `plan` stage produces world-class plans,
nor track the success metric "plan-completeness rubric score ↑ across fixtures",
without first having a way to **score a plan**. So the foundation slice is a
**pure, INERT-on-the-loop plan-quality rubric** (`plan-rubric.ts`) — a sibling
to `eval.ts`'s `scoreTrajectory` (a pure scorer over recorded data), but scoring
a **plan/spec document** (markdown text) rather than a run trajectory.

`scorePlanQuality(doc)` checks the document against the criteria the issue names
explicitly — *scope guard? per-task verification? file map? testable success
criteria?* — plus the rest of the proven shape (problem statement, recorded
decisions/assumptions, task breakdown, failing-test-first). Each criterion is a
**pure deterministic predicate** over the text (header/keyword heuristics, no
tokenizer, no model call); the rubric returns per-criterion results, a met-count
/ max score, a 0..1 completeness ratio, and the list of what is missing — the
"what to improve" surface a later slice feeds back into re-planning.

The token estimate / scoring is heuristic and labelled as such — like P7's
`ceil(chars/4)`, the rubric answers the *completeness* question ("does the plan
have the sections a world-class plan has"), not a semantic-quality judgement
(that stays with the human checkpoint and the model). A pure rubric cannot
regress a run, is fully unit-testable, and is the measurement substrate every
later P8 slice (capture as eval signal, `--plan-report` surface, the `plan`
stage, the human checkpoint) reads.

This first slice is the scorer + formatter only. Wiring (capture into the
evidence bundle / eval signals, an `otto-afk --plan-report` surface, the `plan`
stage + template, the human checkpoint) are separate plan tasks below — one task
per run, each gated on the prior slice.

## Assumptions

Recorded assumptions (autonomous brainstorm — "record assumptions and proceed"):

- **Q: Which scope item first?** → The plan-quality rubric. *Rationale:* the
  issue lists it explicitly and the success metric ("rubric score ↑") presupposes
  it; the `plan` stage's output cannot be evaluated or improved without a scorer.
  Same "measure before optimizing" discipline as P7.
- **Q: Pure module or wire it into the loop in one task?** → Pure module, INERT.
  *Rationale:* repo convention — P0/P1/P3/P4/P5/P7 all shipped pure substrate
  first, pinned by unit tests, never able to regress a run. Keeps the task small
  and TDD-clean.
- **Q: Score the spec, the plan, or both?** → A single scorer over a document
  string, applied to the concatenated spec+plan (or either alone). *Rationale:*
  the criteria (problem, scope guard, file map, per-task verify, success
  criteria) span both files; a caller decides what text to pass. YAGNI on a
  two-document API until a consumer needs it.
- **Q: Heuristic detectors or a model-scored rubric?** → Heuristic, deterministic
  predicates. *Rationale:* must be CI-runnable, pure, and free (mirrors
  `eval.ts`). The model/human judges *semantic* quality at the checkpoint; the
  rubric judges *structural completeness*, which is what the success metric
  tracks and what is cheap to measure honestly.
- **Q: Equal weights or weighted criteria?** → Equal weights, met-count / max.
  *Rationale:* YAGNI; a weighting scheme is speculative until fixtures show a
  criterion deserves more. The per-criterion breakdown lets a consumer reweight
  later without changing the scorer.
- **Q: Which criteria?** → The issue's explicit four (scope guard, per-task
  verification, file map, testable success criteria) plus the proven-shape
  essentials (problem, decisions/assumptions, task breakdown, failing-test-first)
  = eight. *Rationale:* the proven `docs/superpowers` + issue-62 shape is the
  target; scoring only the four named criteria would pass a plan with no problem
  statement or no tasks.

## Scope guard

In scope (this slice): a pure `plan-rubric.ts` scorer + formatter + types,
exported from `index.ts`, pinned by `plan-rubric.test.ts`. **Out of scope** (later
slices, listed in `plan.md`): the `plan` stage and its template; wiring the rubric
into eval signals / the evidence bundle; any CLI surface; the human approval
checkpoint; any loop/behavior change. Non-goals: a semantic/LLM quality judge (the
rubric is structural only); a tokenizer dependency; reweighting/config schemes.

## File map

- `packages/core/src/plan-rubric.ts` — NEW pure module (scorer + formatter + types).
- `packages/core/src/__tests__/plan-rubric.test.ts` — NEW vitest, pins every
  criterion (met + unmet), the ratio math, empty-doc safety, and the formatter.
- `packages/core/src/index.ts` — add the export block (functions then types).
- `.otto/tasks/issue-63/{spec.md,plan.md}` — this spec + the burn-down plan.
- `.otto/LEARNINGS.md` + `.otto/memory/<id>.json` — durable record of the slice.

## Testing notes

- `plan-rubric.test.ts` (vitest, pure): a synthetic "complete" plan that exercises
  every criterion → all met, ratio 1, `missing` empty; a "thin" plan → most unmet,
  low ratio, `missing` lists them; each criterion individually met vs unmet (the
  detector is neither always-true nor always-false); empty/whitespace doc → 0 met,
  ratio 0, no throw; `formatPlanRubric` renders each criterion with a met marker,
  the score, and the missing note.
- INERT: no loop/bin behavior changes this slice, so existing suites are
  unaffected (regression guard = full `pnpm -r typecheck && pnpm -r test &&
  pnpm test` stays green).
