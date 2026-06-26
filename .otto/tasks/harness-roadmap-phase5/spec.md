# Spec — Harness Roadmap Phase 5, P22 First Implementation Slice: context-lifecycle reporting

Source: `docs/HARNESS_ROADMAP_PHASE5.md` (P22–P25).
Slice authored here: the roadmap's **"First Implementation Slice"** —
P22 context-lifecycle _reporting_, **with no behavior change**.

## Problem

AFK token cost is the adoption limiter (roadmap "Product Inputs": "Cost is still
the adoption limiter"). Otto already _measures_ context composition — every stage
record carries a `ContextBreakdown` attributing the rendered prompt to
`commits / learnings / inputs / playbook` (`packages/core/src/context-report.ts`),
surfaced by `otto-afk --context-report`
(`packages/core/src/context-report-cli.ts`). What it cannot yet answer is **"why
is this block still in the window, and could it be freed?"** Stale issue bodies,
old diffs, and settled prior-iteration discussion keep reappearing with no signal
that they are retirable.

The person blocked is the operator deciding whether an AFK run is affordable: they
see _how big_ the context is but not _which part is dead weight_. Until Otto can
name retrievable/resolved context trustworthily in a **report** (a dry run that
changes nothing), it cannot later retire or compress it safely. P22's own
sequencing makes this explicit: "Only after the dry-run report is trustworthy
should Otto start retiring or compressing context automatically."

This slice delivers that trustworthy report and nothing more.

## Decisions

Each is `question → chosen answer → rationale`. No human was available during this
run; these are the safest defaults given existing repo patterns (recorded, not
guessed).

- **How much of Phase 5 should this plan cover?** → **Only the P22 First
  Implementation Slice (context-lifecycle reporting, no behavior change).** →
  The roadmap sequences P22→P23→P24→P25 as NOW/NOW/NEXT/LATER and names this exact
  slice as the recommended start "with no behavior change". Planning P23–P25 at
  one-Otto-run granularity now would be speculative (YAGNI) and the tasks would
  not be independently testable yet. The maintainer approves this slice, then
  re-plans the next. **Blocker recorded:** the remaining initiatives are
  intentionally deferred — see Scope guard.

- **New lifecycle axis vs. reuse existing categories?** → **Add a new orthogonal
  `ContextLifecycle` axis derived from the existing `ContextCategory`, do not
  replace it.** → Mirrors the governed-memory design where `trust`/`confidence`/
  `status` are kept as separate orthogonal axes (`.otto/LEARNINGS.md`: "three
  orthogonal axes … don't collapse them"). Lifecycle is _derived_ from category,
  so it needs no new prompt parsing.

- **Lifecycle → category mapping (the four roadmap classes).** → A pure total
  function `classifyLifecycle(category)`:
  - `playbook` (stage contract / workflow instructions) → **`required-now`**
  - `inputs` (current task source, issue body, active diff) → **`required-now`**
  - `commits` (prior-iteration commit log — already-settled discussion) →
    **`resolved`**
  - `learnings` (governed memory + final decisions) → **`durable`**
    → The roadmap's own definitions: `required-now` = "stage contract, current task,
    active diff"; `resolved` = "previous … discussion, completed subtasks";
    `durable` = "governed memory and final decisions". `retrievable` ("logs, issue
    bodies, command output, screenshots") has **no distinct existing category** at
    this granularity, so it is part of the taxonomy/type but is not produced by the
    current four categories. Recorded as an honest gap (Testing notes + Scope guard)
    rather than faking a mapping — finer-grained `inputs` segmentation (issue body
    vs. task source) is a follow-up slice.

- **"Freeable context" recommendation: retire vs compress?** → **A pure dry-run
  assessor `assessFreeableContext(breakdown)` that names `resolved` segments as
  _retirable_ and `retrievable` segments as _compressible_, with estimated token
  savings, and changes nothing.** → The roadmap's slice step 3: "a dry-run
  'freeable context' recommendation that reports what could be retired or
  compressed without actually changing the prompt." Mirrors the existing
  `assessContextBudget` pure-assessor shape (`context-budget.ts`).

- **Where does lifecycle live so it persists on stage records?** → **Attach a
  derived `lifecycle` field to each `ContextSegment` inside `analyzeContext`.** →
  `StageRecord.contextBreakdown` is already serialized to
  `.otto/runs/<id>/stages/*.json` (`run-report.ts`), so a new optional field on
  the segment persists for free and is backward-compatible (older records simply
  lack it; readers already treat `contextBreakdown` as optional).

- **Behavior change this slice?** → **None. Report-only, INERT on the loop.** →
  Matches every prior context slice (`context-report.ts`/`context-budget.ts` are
  documented "INERT on the loop"). Automatic retirement/compression is explicitly
  the _next_ slice, gated on this report being trusted.

- **How to prove the report is trustworthy?** → **One large-context fixture** (a
  rendered prompt with substantial `commits`/`learnings`/`inputs` blocks) asserting
  the lifecycle rollup and freeable recommendation classify resolved/durable/
  required-now correctly. → The roadmap's slice step 4: "one large-context fixture
  where the report must identify retrievable and resolved context correctly."

## Scope guard

**In scope (this slice only):**

- A pure lifecycle taxonomy + `classifyLifecycle` mapping.
- A derived `lifecycle` field on `ContextSegment` (persists on stage records).
- A pure `assessFreeableContext` dry-run recommendation + its formatter.
- A lifecycle rollup + freeable section added to `otto-afk --context-report`.
- One large-context fixture test pinning the classification.

**Explicitly OUT of scope (deferred to later plan runs):**

- **Automatic context retirement or compression** — actually mutating the rendered
  prompt, freeing prior-iteration context, or pulling Headroom. Report-only here;
  the roadmap gates automation behind a trusted report.
- **A distinct `retrievable` producer** — finer `inputs` segmentation (issue body
  vs. active task vs. command output) so `retrievable` is populated from real
  content. The type carries the class; no current category emits it.
- **P23 Input sharpening, P24 Visual/artifact verification, P25 Multi-agent
  coordination** — separate initiatives; each gets its own spec/plan run.
- **Eval-backed compression survival fixtures** (P22 later scope) and the
  Headroom selective-compression wiring.
- Any new bin, flag default change, or change to non-context stage behavior.
- No new dependencies; ESM `.js` import convention preserved.

## File map

Create:

- `packages/core/src/context-lifecycle.ts` — new pure module: `ContextLifecycle`
  type, `classifyLifecycle`, `summarizeLifecycle`, `assessFreeableContext`,
  `formatFreeableContext`.
- `packages/core/src/__tests__/context-lifecycle.test.ts` — unit tests for the
  new module (classification table, rollup totals, freeable assessment).

Modify:

- `packages/core/src/context-report.ts` — add the derived `lifecycle` field to
  `ContextSegment` (populated in `analyzeContext`).
- `packages/core/src/context-report-cli.ts` — extend `formatContextReportRun`
  with a lifecycle-totals rollup + a freeable-context section.
- `packages/core/src/index.ts` — re-export the new `context-lifecycle.ts` symbols.
- `packages/core/src/__tests__/context-report.test.ts` — assert segments now carry
  `lifecycle`.
- `packages/core/src/__tests__/context-report-cli.test.ts` — assert the report
  renders lifecycle totals + freeable section; add the large-context fixture case.

Reference only (read, not modified): `packages/core/src/run-report.ts`
(`StageRecord.contextBreakdown` serialization), `packages/core/src/context-budget.ts`
(assessor pattern to mirror), `packages/core/src/stage-exec.ts:209` (capture site —
unchanged; lifecycle rides along on the breakdown it already records).

## Testing notes

Verification command for every task: `pnpm -r typecheck && pnpm -r test`
(plus `pnpm test` for root contract tests on the final task). The smoke-template
budget guard (`scripts/smoke-templates.mjs`, <20k tokens/template) is unaffected —
no template changes in this slice.

**Testable success criteria (done-when):**

1. `classifyLifecycle` is a total function over all four `ContextCategory` values,
   returning `required-now` for `playbook`/`inputs`, `resolved` for `commits`,
   `durable` for `learnings` — pinned by a table test in
   `context-lifecycle.test.ts`.
2. `analyzeContext(prompt).segments[i].lifecycle` is present and correct for a
   prompt containing each block — pinned in `context-report.test.ts`.
3. `assessFreeableContext` reports the `resolved` (commits) bytes as _retirable_
   and any `retrievable` bytes as _compressible_, with a token estimate, and
   reports zero freeable when only `required-now`/`durable` segments exist —
   pinned in `context-lifecycle.test.ts`.
4. `otto-afk --context-report` output includes a lifecycle-totals line and a
   freeable-context line for a run whose stage records carry breakdowns — pinned
   in `context-report-cli.test.ts`.
5. A **large-context fixture** (commits/learnings/inputs each ≥ a few KB) yields a
   report that names the commits block as resolved/retirable and the learnings
   block as durable — pinned in `context-report-cli.test.ts`.
6. No behavior change: `analyzeContext` totals/segments order are unchanged
   (existing assertions still pass); nothing runs a stage or mutates a prompt.
7. `pnpm -r typecheck && pnpm -r test && pnpm test` all green.
