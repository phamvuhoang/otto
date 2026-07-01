# Plan — P22 slice 3: eval-backed fact-survival proof (report/eval-only)

Design: `docs/superpowers/specs/2026-07-02-compression-survival-eval-design.md`.
Ordered; each task = one Otto run, gated on the prior, failing-test-first, with an
explicit verify command. Scope is the survival scorer + fixture + gated
real-Headroom proof only; no live-loop change (see spec Scope guard).

**Prior slices are landed — do not redo them:**

- Slice 1 & 2 (context-lifecycle reporting, the `evidence → retrievable` producer,
  `lifecycleRationale`, the freeable dry run, the `--context-report` rollup) all
  shipped in **PR #178** (`072f444`). The earlier on-disk "slice 2" plan that
  called this unimplemented was a stale re-plan; #178 already delivered it.
- Real Headroom `compress()` library mode shipped in **PR #193**, and the spill
  path already compresses retrievable issue bodies with reversible evidence.

- [ ] **T1 — `assessFactSurvival` pure scorer + formatter.**
      Failing test first: add
      `packages/core/src/__tests__/compression-survival.test.ts` asserting
      `assessFactSurvival(facts, compressed)` returns exact `survived` / `missing`
      / `survivalRate` for all-survive, some-missing, empty-facts, and mixed-case
      inputs, and that `formatFactSurvival` renders a one-line summary. Watch it
      fail (module absent). Then add `packages/core/src/compression-survival.ts`
      with the `FactSurvival` type, the pure `assessFactSurvival` (normalized
      case-insensitive substring match), and the pure `formatFactSurvival`; re-export
      both from `packages/core/src/index.ts`.
      verify: `pnpm -r typecheck && pnpm -r test`

- [ ] **T2 — survival fixture + gated real-Headroom e2e.**
      In the same test file add (a) a realistic multi-KB issue-body fixture with a
      documented list of distinctive buried facts (error code, semver, file path,
      config key, a numbered acceptance criterion), and (b) a gated
      (`OTTO_HEADROOM_E2E=1`, skipped by default — mirrors the existing e2e block)
      real-Headroom test that compresses the fixture through `libraryHeadroomRunner`
      and asserts the payload shrank AND `assessFactSurvival` reports survival
      at/above the documented floor. Read-only; no loop or prompt change.
      verify: `pnpm -r typecheck && pnpm -r test && pnpm test`
