# Spec — issue #62: P7 Context & token efficiency

## Problem

A long Otto run's per-iteration token cost grows with run length because
accumulated context (full `LEARNINGS.md`, re-fed prior-iteration transcript,
re-read files) keeps inflating the prompt — not because the work needs it. P7's
outcome: hold per-iteration token cost roughly flat, cutting cost-per-task with
no quality loss.

The issue is **Large** with six scope items. Its own first directive is
**"Context telemetry first — measure before optimizing."** Every optimization
(prefix caching, bounded learnings, compaction, read-dedup, budget) needs a way
to attribute what filled the window before it can prove it helped.

## Approach

Ship the telemetry foundation first, as a **pure, INERT-on-the-loop module**
(`context-report.ts`), mirroring how P0/P1/P3 substrate shipped pure-then-wired
(`tokens.ts`, `eval.ts`, `memory.ts`). A pure analyzer cannot regress a run, is
fully unit-testable, and is the measurement substrate every later P7 slice reads.

`analyzeContext(renderedPrompt)` segments the **rendered** stage prompt into the
categories that actually fill the inline window and reports chars + an estimated
token count per category. The rendered ghafk/afk/ghafk-issue prompts share stable
top-level XML-ish block markers (verified in `templates/{afk,ghafk,ghafk-issue}.md`):

- `<commits>…</commits>` → **commits** (recent `git log`)
- `<learnings>…</learnings>` → **learnings** (the whole `LEARNINGS.md` injection)
- `<inputs>` / `<issue>` / `<issues-summary>` / `<issues-full-file>` → **inputs**
  (the task source: plan/PRD text or issue bodies/comments)
- everything outside a recognized block → **playbook** (the workflow instructions)

Token count is the standard `ceil(chars / 4)` rough estimate (no tokenizer dep);
it is an *estimate* and labelled as such — the authoritative per-stage token usage
already comes from the provider via `tokens.ts`. This breakdown answers the
*composition* question ("which section is the prompt made of") that the usage
total cannot.

This first slice is the analyzer + formatter only. Wiring (capture into
`StageResult`/the evidence bundle, an `otto-afk --context-report` surface) and the
remaining five optimizations are separate plan tasks below — one task per run.

## Assumptions

- **Q: Which of the six scope items first?** → Context telemetry. *Rationale:* the
  issue names it first and explicitly ("measure before optimizing"); the success
  metrics (tokens/iteration slope, cache-hit rate) all presuppose measurement.
- **Q: Pure module or wire it into the loop in one task?** → Pure module, INERT.
  *Rationale:* repo convention — P0/P1/P3/P4/P5 all shipped pure substrate first,
  pinned by unit tests, never able to regress a run (see `<learnings>`: "INERT
  until … wired in … can't regress existing behavior"). Keeps the single task
  small and TDD-clean.
- **Q: Segment the rendered prompt or the raw template?** → The **rendered**
  prompt. *Rationale:* telemetry must reflect real billed footprint after
  `@include`/`@spill`/shell expansion, not the template skeleton.
- **Q: Real tokenizer or estimate?** → `ceil(chars/4)` estimate, labelled.
  *Rationale:* YAGNI/no new dep; provider gives authoritative usage already
  (`tokens.ts`). The breakdown's job is *composition share*, not exact billing.
- **Q: `file reads` / `prior-iteration transcript` categories (named in the
  issue)?** → Out of this slice. *Rationale:* those are agent-runtime / cross-
  iteration concepts, not present in a single rendered prompt; they belong to the
  read-dedup and inter-iteration-compaction tasks, which is where they are
  measurable.
- **Q: Segment ordering in the report?** → Descending by chars (largest filler
  first), tie-broken by a fixed category order. *Rationale:* "what filled the
  window" is most useful biggest-first.

## Testing notes

- `context-report.test.ts` (vitest, pure): `analyzeContext` on a synthetic
  rendered prompt containing each block → correct per-category chars; unknown
  text → `playbook`; absent block → category omitted (or zero); totals add up
  (sum of segment chars === total chars); token estimate === `ceil(chars/4)`;
  `formatContextReport` renders each present category with a percentage and the
  estimate label; empty prompt → zero totals, no throw.
- INERT: no loop/bin behavior changes this slice, so existing suites are
  unaffected (regression guard = full `pnpm -r test && pnpm test` stays green).
