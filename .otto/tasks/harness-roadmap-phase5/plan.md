# Plan — P22 slice 2: a real `retrievable` producer (no behavior change)

Spec: `.otto/tasks/harness-roadmap-phase5/spec.md`. Ordered; each task = one Otto
run, gated on the prior, failing-test-first, with an explicit verify command.
Scope is the `retrievable` producer + the report's "why" rationale only; Headroom
compression and retirement automation are out of scope (see spec Scope guard).

The prior slice (context-lifecycle reporting) is already landed on this branch
(commits `4be129f`…`c7b24eb`) — do not redo it.

- [ ] **T1 — `evidence` category producer → `retrievable`.**
      Failing test first: (a) in
      `packages/core/src/__tests__/context-lifecycle.test.ts` extend the
      `classifyLifecycle` table with `evidence → retrievable` (and keep the four
      existing rows); (b) in
      `packages/core/src/__tests__/context-report.test.ts` update the existing
      "treats afk `<inputs>` and ghafk `<issues-summary>`/`<issues-full-file>` as
      inputs" case so the issue-body tags now assert `category: "evidence"` /
      `lifecycle: "retrievable"`, while afk `<inputs>` still asserts
      `category: "inputs"` / `lifecycle: "required-now"`. Watch both fail (and note
      `pnpm -r typecheck` fails on the non-exhaustive switch once `"evidence"` is
      added to the union — the compiler-enforced guard). Then in
      `packages/core/src/context-report.ts` add `"evidence"` to the
      `ContextCategory` union and remap `issue` / `issues-summary` /
      `issues-full-file` in `BLOCK_CATEGORY` to `"evidence"`; in
      `packages/core/src/context-lifecycle.ts` add `case "evidence": return
    "retrievable"` to `classifyLifecycle`. Confirm `analyzeContext` total chars
      still equal `prompt.length` (existing assertions pass — no chars lost, only
      recategorized). verify: `pnpm -r typecheck && pnpm -r test`

- [ ] **T2 — "why is this still in context?" rationale + large issue-body fixture.**
      Failing test first: (a) in
      `packages/core/src/__tests__/context-lifecycle.test.ts` add a
      `lifecycleRationale` case asserting a distinct non-empty string for each of
      `required-now` / `resolved` / `durable` / `retrievable`; (b) in
      `packages/core/src/__tests__/context-report-cli.test.ts` add a
      **large issue-body fixture** — stage records whose `contextBreakdown` has a
      multi-KB `evidence`/`retrievable` segment plus a `commits`/`resolved`
      segment — asserting `formatContextReportRun` output (i) names the issue-body
      bytes as `compress`/`retrievable` and the commits as `retire`/`resolved` in
      the freeable line, and (ii) renders a per-class rationale line. Watch both
      fail (helper absent; rationale not rendered). Then add and export the pure
      `lifecycleRationale(lifecycle)` in
      `packages/core/src/context-lifecycle.ts` (re-export from
      `packages/core/src/index.ts`), and render it under the existing lifecycle
      rollup in `formatContextReportRun`
      (`packages/core/src/context-report-cli.ts`). Read-only; no loop or prompt
      change. verify: `pnpm -r typecheck && pnpm -r test && pnpm test`
