# Plan — P22 First Slice: context-lifecycle reporting (no behavior change)

Spec: `.otto/tasks/harness-roadmap-phase5/spec.md`. Ordered, each task = one Otto
run, each gated on the prior. Every task is failing-test-first and names its
verify command. Scope is the roadmap's First Implementation Slice only; P23–P25
and automatic retirement are out of scope (see spec Scope guard).

- [ ] **T1 — Lifecycle taxonomy + classifier (pure module).**
      Failing test first: add `packages/core/src/__tests__/context-lifecycle.test.ts`
      with a `classifyLifecycle` table case — `playbook`→`required-now`,
      `inputs`→`required-now`, `commits`→`resolved`, `learnings`→`durable` — and a
      `summarizeLifecycle(breakdown)` case asserting per-lifecycle char/token totals
      sum to the breakdown total. Watch it fail (module absent). Then create
      `packages/core/src/context-lifecycle.ts` exporting the `ContextLifecycle` type,
      total `classifyLifecycle(category)`, and pure `summarizeLifecycle(breakdown)`;
      re-export both from `packages/core/src/index.ts`. No loop wiring.
      verify: `pnpm -r typecheck && pnpm -r test`

- [ ] **T2 — Derive `lifecycle` onto each `ContextSegment`.**
      Failing test first: extend `packages/core/src/__tests__/context-report.test.ts`
      to assert `analyzeContext(prompt).segments[i].lifecycle` is set and correct for
      a prompt with `<commits>`, `<learnings>`, `<inputs>` blocks plus playbook text.
      Watch it fail (field absent). Then add the optional `lifecycle: ContextLifecycle`
      field to `ContextSegment` in `packages/core/src/context-report.ts` and populate
      it in `analyzeContext` via `classifyLifecycle`. Confirm existing
      totals/segment-order assertions still pass (no behavior change), and that
      `StageRecord.contextBreakdown` now carries lifecycle for free (serialization is
      untouched). verify: `pnpm -r typecheck && pnpm -r test`

- [x] **T3 — Freeable-context dry-run assessor + formatter (pure).**
      Failing test first: extend `context-lifecycle.test.ts` with an
      `assessFreeableContext(breakdown)` case — a breakdown with a large `commits`
      (`resolved`) segment reports those bytes as _retirable_ with a token estimate; a
      breakdown of only `inputs`/`playbook`/`learnings` reports zero freeable; and
      `formatFreeableContext` renders a one-line human summary. Watch it fail. Then add
      `assessFreeableContext` + `formatFreeableContext` to
      `packages/core/src/context-lifecycle.ts` (mirror the `assessContextBudget` /
      `formatContextBudget` shape in `context-budget.ts`); export from `index.ts`.
      Dry-run only — returns a recommendation, mutates nothing.
      verify: `pnpm -r typecheck && pnpm -r test`

- [ ] **T4 — Wire lifecycle totals + freeable section into `--context-report`,
      with the large-context fixture.**
      Failing test first: extend
      `packages/core/src/__tests__/context-report-cli.test.ts` with (a) an assertion
      that `formatContextReportRun` output contains a lifecycle-totals line and a
      freeable-context line for stage records carrying breakdowns, and (b) a
      **large-context fixture** — a rendered prompt with `commits`/`learnings`/`inputs`
      blocks each several KB — asserting the report names the commits block as
      resolved/retirable and the learnings block as durable. Watch both fail. Then
      extend `formatContextReportRun` in
      `packages/core/src/context-report-cli.ts` to render `summarizeLifecycle` totals
      and `formatFreeableContext` from the measured stages. Read-only; no loop or
      prompt change. verify: `pnpm -r typecheck && pnpm -r test && pnpm test`
