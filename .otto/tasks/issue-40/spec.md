# Issue #40 — P1: Harness evaluation suite

Part of the Otto Harness Enhancement Roadmap · Epic #38 · Priority P1.

## Problem

Otto changes (runtime, prompt, review-panel, memory, routing) currently ship
without a repeatable way to measure their effect on **harness quality** —
separate from the chosen model. Evaluation today is unit/integration tests, not
benchmark-style measurement of task success, cost, latency, and safety.

The issue asks for a benchmark **suite**: fixtures, a cross-config runner,
multi-signal scoring, and a comparison report built from the run-trajectory
model (the P0 evidence bundle shipped in #39: `.otto/runs/<run-id>/` =
`RunManifest` + `StageRecord[]`).

## Approach

Build the suite bottom-up, deterministic-first, mirroring how P0 (#39) landed —
a pure data/scoring substrate first, then wiring, then fixtures, then the bin.

The evaluation has two halves with very different properties:

- **Deterministic (CI-runnable):** scoring a *recorded* trajectory into
  multi-signal outcomes, and comparing scores across runs. No model calls. This
  is the "cheap deterministic subset" the success metrics require.
- **Model-dependent (paid/manual):** actually replaying fixture tasks across
  configurations (`claude`, `codex`, token modes, panel on/off, …). Expensive
  and non-deterministic; gated behind a maintainer-run command, never CI.

This spec starts with the deterministic core so every later piece (runner,
fixtures, report) composes pure, tested functions.

### First slice (this run's task)

A pure module `packages/core/src/eval.ts`:

- `EvalSignals` — the multi-signal outcome derivable purely from a trajectory:
  `succeeded`, `exitReason`, `completedIterations`, `stageCount`,
  `errorStageCount`, `costUsd`, `totalTokens`, `elapsedMs`.
- `scoreTrajectory(manifest: RunManifest, stages: StageRecord[]): EvalSignals`
  — derives those signals from a #39 evidence bundle. No I/O, no model calls.

Kept **inert** (not imported by any bin/loop) — like `task-key.ts` and the
initial `run-report.ts` substrate — so adding it cannot regress existing runs.

### Signal derivation rules

- `succeeded` — `true` iff `exitReason ∈ {"complete", "done"}` (the loop's
  success reasons; everything else — `done with failures`, `stopped (budget)`,
  `halted (rate limit)`, `aborted`, `stopped (error)`, or un-finalized — is
  `false`).
- `exitReason` — passed through from the manifest (`null` when un-finalized).
- `completedIterations` — from the manifest (`null` when un-finalized).
- `stageCount` — `stages.length`.
- `errorStageCount` — count of stage records with `isError === true`.
- `costUsd` — `manifest.costUsd`.
- `totalTokens` — `tokenUsageTotal(manifest.tokenUsage)`.
- `elapsedMs` — `Date.parse(finishedAt) - Date.parse(startedAt)`, or `null`
  when the run is un-finalized (no `finishedAt`) or either timestamp is
  unparseable. Never negative-by-bug: an unparseable pair yields `null`, not a
  NaN.

## Assumptions

- **Q: How much of issue #40 to land this run?** → Only the pure
  `scoreTrajectory` substrate. Rationale: the issue is large; the repo's
  established pattern (#39) is substrate-first, and this is the deterministic
  foundation the rest composes on. One TDD task per the AFK protocol.
- **Q: Which signals first?** → Only the trajectory-derivable ones.
  Tests-passed / diff-correctness / safety-events need the runner + fixtures and
  are later plan tasks. Rationale: YAGNI; keep the first module pure and CI-safe.
- **Q: Module name?** → `eval.ts` (the bin will be `otto-eval`), mirroring
  `run-report.ts`. A module-specifier string is unaffected by `eval` being a
  global; no shadowing risk.
- **Q: Wire it in now?** → No. Inert until later tasks build the report
  formatter and runner on top, matching `task-key.ts`'s inert-until-wired
  approach. Rationale: cannot regress existing behavior.
- **Q: `succeeded` definition?** → Only `complete`/`done`. `done with failures`
  is explicitly NOT a success (a stage failed). Rationale: matches the loop's
  own `sawFailure` distinction.

## Testing notes

Pin with `packages/core/src/__tests__/eval.test.ts` (vitest), constructing
in-memory `RunManifest`/`StageRecord` fixtures (no fs):

- succeeded for `complete` and `done`; not for `done with failures`, budget,
  rate-limit, aborted, error, and un-finalized.
- `stageCount` / `errorStageCount` over a mix of ok and error stages.
- `costUsd` / `totalTokens` pass-through and token summation.
- `elapsedMs` computed from timestamps; `null` when un-finalized; `null` when a
  timestamp is unparseable.
- empty stage list → zero counts, signals still derive from the manifest.

Feedback loops: `pnpm -r typecheck && pnpm -r test`.
