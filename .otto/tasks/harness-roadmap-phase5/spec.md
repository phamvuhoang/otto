# Spec — Harness Roadmap Phase 5, P22 slice 3: eval-backed fact-survival proof

Full design + rationale: `docs/superpowers/specs/2026-07-02-compression-survival-eval-design.md`.
Source roadmap: P22 (issue #179). Report/eval-only, no behavior change.

## Prior slices are DONE

- **Context-lifecycle reporting + the `retrievable` producer** (`evidence`
  category, `classifyLifecycle`, `lifecycleRationale`, freeable dry run,
  `--context-report` rollup) shipped in **PR #178** (`072f444`). An earlier
  on-disk plan re-planned this as an unimplemented "slice 2" — that was stale;
  #178 delivered it. This file supersedes it.
- **Real Headroom `compress()` library mode** shipped in **PR #193**. The spill
  path (`compressSpill` in `stage-exec.ts`, `spillCategory("issue.json") →
"issue-body"`) already compresses retrievable issue bodies reversibly, with a
  `toolsUsed[]` record.

## Problem

The roadmap gates trusting/expanding compression on: _"use Headroom selectively
for `retrievable` categories where **eval proves buried facts survive
compression**."_ No such eval exists. The one real-Headroom test proves the
payload **shrinks**, not that specific buried facts **survive**. Compression is
therefore trusted on faith — the exact thing the roadmap forbids. This slice
supplies the missing proof.

## Scope guard

**In scope:** a pure `assessFactSurvival` + `formatFactSurvival`
(`compression-survival.ts`), deterministic unit tests, a documented issue-body
survival fixture, and a gated (`OTTO_HEADROOM_E2E=1`) real-Headroom e2e proving
buried facts survive; plus this doc refresh.

**Out of scope (later slices):** changing what the live loop compresses;
lifecycle-selective compression among spill categories; prior-iteration
retirement; skill/tool context caps; any new bin/flag. No new dependencies; ESM
`.js` imports preserved.

## Testable success criteria

- `assessFactSurvival` returns exact `survived` / `missing` / `survivalRate` for
  all-survive, some-missing, empty-facts, and mixed-case inputs.
- `formatFactSurvival` renders a distinct one-line summary.
- The gated e2e (opt-in) compresses the fixture and asserts size shrank AND
  survival is at/above the documented floor.
- No behavior change: no stage runs, no prompt mutates; the normal suite is green
  with the e2e skipped.
- `pnpm -r typecheck && pnpm -r test && pnpm test` all green.
