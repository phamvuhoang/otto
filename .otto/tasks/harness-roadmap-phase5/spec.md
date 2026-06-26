# Spec — Harness Roadmap Phase 5, P22 slice 2: a real `retrievable` producer (report-only)

Source: `docs/HARNESS_ROADMAP_PHASE5.md` (P22). This is the **second** P22 slice.

**Prior slice is DONE.** The roadmap's "First Implementation Slice" — P22
context-lifecycle _reporting_, no behavior change — landed on this branch:
`classifyLifecycle` + taxonomy (`4be129f`), lifecycle on each `ContextSegment`
(`6bdbab9`), the freeable dry-run assessor + formatter (`73c4656`), and the
lifecycle rollup + freeable section in `otto-afk --context-report` (`c7b24eb`).
Per that spec's own decision ("the maintainer approves this slice, then re-plans
the next"), this run authors the next slice. The old slice's spec/plan are in
git history.

## Problem

The freeable-context report shipped, but it can only ever name **`resolved`**
context (the commit log) as freeable. The fourth lifecycle class the roadmap
defines — **`retrievable`** ("logs, issue bodies, command output, screenshots")
— is in the taxonomy but **no category produces it**. `classifyLifecycle` maps
every `inputs` block to `required-now`, and the ghafk issue-body block tags
(`<issue>`, `<issues-summary>`, `<issues-full-file>`) are lumped into the same
`inputs` category (`packages/core/src/context-report.ts` `BLOCK_CATEGORY`).

So on a ghafk run whose window is dominated by a multi-KB pasted issue body, the
report says that bulk is `required-now` and **un-freeable** — exactly backwards.
An issue body is reconstructable evidence (`gh issue view` re-fetches it); it is
the textbook `retrievable`/compressible block. The operator deciding whether an
AFK run is affordable is told the most compressible part of their window is
load-bearing.

The roadmap gates all compression/retirement automation behind one condition:
"Only after the dry-run report is trustworthy should Otto start retiring or
compressing context automatically." The report is **not** trustworthy until
`retrievable` reflects real content. This slice makes it trustworthy for
issue-body evidence — still report-only, still no behavior change — which is the
precondition for the P22 Headroom-selective-compression work that follows.

The prior slice recorded this exact gap as deferred work (old spec Scope guard:
"A distinct `retrievable` producer — finer `inputs` segmentation … The type
carries the class; no current category emits it"). This slice closes it.

## Decisions

Each is `question → chosen answer → rationale`. No human was available during
this run; these are the safest defaults given existing repo patterns (recorded,
not guessed).

- **How much to plan now?** → **Only this one slice: a `retrievable` producer +
  the report's "why is this still in context?" rationale, report-only.** → Keeps
  the prior slice's YAGNI discipline. The next behavior-changing steps (Headroom
  selective compression, prior-iteration retirement, skill/tool context caps,
  eval-survival fixtures) each get their own spec/plan once this report is
  trusted. Planning them now would be speculative and not independently testable.

- **How to make a category classify as `retrievable` (lifecycle is derived from
  category only)?** → **Add one new `ContextCategory` — `evidence` — and remap
  the issue-body block tags to it; `classifyLifecycle(evidence) → retrievable`.**
  → The whole design is "lifecycle is a pure total function of category"
  (`context-lifecycle.ts`). The only design-consistent way to emit `retrievable`
  is a category that maps to it. Splitting issue-body tags out of `inputs` is the
  minimal change; the afk `<inputs>` block (the active plan/PRD task source) stays
  `inputs`/`required-now` because it IS the current task, not retrievable evidence.

- **Why the name `evidence` and not `issue`?** → **`evidence`.** → The roadmap's
  `retrievable` examples are issue bodies, logs, command output, screenshots — all
  reconstructable _evidence_. Today only the three issue-body tags populate it, but
  the name leaves room for future producers (command-output spills) to join the
  same category without another rename. Honest scope: this slice only wires the
  issue-body tags; the category is named for where it is going.

- **Does this break `context-budget.ts`?** → **No.** → `REDUCIBLE_LEVERS` is a
  `Partial<Record<ContextCategory, …>>` keyed only on `commits`/`learnings`
  (`context-budget.ts:66`). A new `evidence` category is simply absent from it, so
  `assessContextBudget` ignores it — correct, since issue bodies are freed via the
  lifecycle/Headroom path, not the commit/learnings compaction lever. Verified: the
  only `ContextCategory` consumers are `context-report.ts`, `context-budget.ts`,
  `context-lifecycle.ts`, `index.ts`.

- **The roadmap's "why is this still in context?" breakdown — done?** → **Half.**
  → The "can be freed" estimate shipped (the freeable line). The plain-language
  _why each class is present_ breakdown did not. This slice adds a pure
  `lifecycleRationale(lifecycle) → string` (required-now = active task/contract;
  resolved = settled prior iterations; durable = governed memory; retrievable =
  reconstructable evidence) rendered under the report's lifecycle rollup, closing
  P22 scope bullet 2.

- **Behavior change this slice?** → **None. Report-only, INERT on the loop.** →
  Matches every prior context slice. `analyzeContext` still attributes 100% of the
  prompt (the `evidence` chars were already counted under `inputs`; they only move
  category), nothing runs a stage or mutates a prompt. The only observable delta is
  in `--context-report` output and the derived `lifecycle`/`category` on stage
  records.

- **How to prove trustworthiness?** → **A large issue-body fixture.** → A
  ghafk-style rendered prompt with a multi-KB `<issues-full-file>` block plus a
  `<commits>` block, asserting the report names the issue-body bytes as
  `retrievable`/compressible and the commits as `resolved`/retirable. This is the
  roadmap slice's "fixture where the report must identify retrievable and resolved
  context correctly," now satisfiable because `retrievable` has a producer.

## Scope guard

**In scope (this slice only):**

- A new `evidence` `ContextCategory`; the issue-body block tags (`issue`,
  `issues-summary`, `issues-full-file`) remapped to it.
- `classifyLifecycle(evidence) → retrievable` (total switch updated).
- A pure `lifecycleRationale(lifecycle)` helper + its render in
  `otto-afk --context-report`.
- A large issue-body fixture proving the report classifies retrievable/resolved
  correctly.

**Explicitly OUT of scope (deferred to later plan runs):**

- **Headroom / actual compression of `retrievable` content** — wiring the
  compressor to summarize/spill issue bodies. Report-only here; the roadmap gates
  real compression behind this report being trusted. This is the very next slice.
- **Automatic prior-iteration retirement** of `resolved` context.
- **Skill/tool context caps and dropping unused skill excerpts** (P22 scope).
- **Eval fixtures that prove buried facts survive compression** — those need the
  compressor to exist first (out of scope above).
- **Finer `evidence` producers** (command-output spills, screenshots) — only the
  issue-body tags are wired now; the category is named to admit them later.
- **P23 Input sharpening, P24 Visual verification, P25 Multi-agent** — separate
  initiatives, each its own spec/plan run.
- Any new bin, flag, or change to non-context stage behavior. No new dependencies;
  ESM `.js` import convention preserved.

## File map

Create: _none_ (extends the modules the prior slice created).

Modify:

- `packages/core/src/context-report.ts` — add `"evidence"` to the
  `ContextCategory` union; remap `issue` / `issues-summary` / `issues-full-file`
  in `BLOCK_CATEGORY` from `inputs` to `evidence`.
- `packages/core/src/context-lifecycle.ts` — add the `case "evidence": return
"retrievable"` arm to `classifyLifecycle`; add and export the pure
  `lifecycleRationale(lifecycle)` helper.
- `packages/core/src/context-report-cli.ts` — render a per-class rationale
  ("why is this still in context?") under the existing lifecycle rollup in
  `formatContextReportRun`.
- `packages/core/src/index.ts` — re-export the new `lifecycleRationale` symbol.
- `packages/core/src/__tests__/context-report.test.ts` — update the existing
  "treats … as inputs" case (issue tags are now `evidence`/`retrievable`; afk
  `<inputs>` stays `inputs`/`required-now`).
- `packages/core/src/__tests__/context-lifecycle.test.ts` — extend the
  `classifyLifecycle` table (`evidence → retrievable`); add a `lifecycleRationale`
  case.
- `packages/core/src/__tests__/context-report-cli.test.ts` — assert the report
  renders the rationale lines; add the large issue-body fixture case.

Reference only (read, not modified): `packages/core/src/context-budget.ts`
(`REDUCIBLE_LEVERS` — confirmed unaffected), `packages/core/src/run-report.ts`
(`StageRecord.contextBreakdown` serialization — carries the new category/lifecycle
for free).

## Testing notes

Verification command for every task: `pnpm -r typecheck && pnpm -r test` (plus
`pnpm test` for root contract tests on the final task). No template changes, so
the smoke-template budget guard (`scripts/smoke-templates.mjs`) is unaffected.

The `classifyLifecycle` switch is total over the `ContextCategory` union, so
adding `"evidence"` to the union makes `pnpm -r typecheck` **fail** until the new
case is added — a compiler-enforced exhaustiveness guard, noted as a verify step
in T1.

**Testable success criteria (done-when):**

- `classifyLifecycle("evidence") === "retrievable"`, and the four prior mappings
  are unchanged — pinned by the table test in `context-lifecycle.test.ts`.
- `analyzeContext` on a prompt with `<issues-full-file>` (or `<issue>` /
  `<issues-summary>`) yields a segment with `category: "evidence"`,
  `lifecycle: "retrievable"`; a prompt with afk `<inputs>` still yields
  `category: "inputs"`, `lifecycle: "required-now"` — pinned in
  `context-report.test.ts`.
- `analyzeContext` total chars still equal `prompt.length` (the evidence chars
  moved category, none were lost) — existing total-attribution assertions still
  pass.
- `lifecycleRationale` returns a distinct non-empty rationale for each of the four
  lifecycle classes — pinned in `context-lifecycle.test.ts`.
- `assessFreeableContext` on a breakdown containing an `evidence`/`retrievable`
  segment reports those bytes as `compress`-able with a token estimate (already
  generic in the assessor; now reachable) — pinned in `context-lifecycle.test.ts`
  or via the CLI fixture below.
- `otto-afk --context-report` output, for a run whose stage records carry an
  issue-body-heavy breakdown, includes a `retrievable`/`compress` freeable line
  AND a per-class rationale line — pinned in `context-report-cli.test.ts`.
- A **large issue-body fixture** (a `<issues-full-file>` block several KB plus a
  `<commits>` block) yields a report naming the issue-body block as
  retrievable/compressible and the commits block as resolved/retirable — pinned in
  `context-report-cli.test.ts`.
- No behavior change: nothing runs a stage or mutates a prompt; only report output
  and the derived `category`/`lifecycle` change.
- `pnpm -r typecheck && pnpm -r test && pnpm test` all green.
