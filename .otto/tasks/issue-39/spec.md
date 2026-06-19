# Spec — issue #39: Run trajectory and evidence bundle (P0)

## Problem

Today a maintainer reconstructs "what happened and why did Otto stop?" from
scattered `.otto-tmp/logs/*.ndjson` and the single stdout summary line. There is
no durable, structured record of a run's trajectory (inputs, runtime, per-stage
results, token/cost totals, exit reason, artifacts). The issue asks for a
per-run **evidence bundle** under `.otto/runs/<run-id>/` plus a way to render a
human summary from it.

## Approach

Build the measurement substrate first, then wire it in, then render it — the
issue's own "first implementation slice". See `plan.md` for the task list. This
slice must not alter prompts, stage routing, runtime selection, or review
behavior; it only *records*.

This iteration implements **task 1**: a pure `packages/core/src/run-report.ts`
module — types + run-id allocator + path helpers + manifest/stage-record I/O —
fully unit-tested and inert (nothing imports it from the loop yet), so it cannot
regress existing behavior. It mirrors `state.ts` (pure fs helpers, JSON, absent/
malformed → safe null, injectable `Date`/`pid` for determinism).

Bundle layout (established here, consumed by later tasks):

```
.otto/runs/<run-id>/
  manifest.json        # one RunManifest
  stages/
    0000-iter1-implementer.json   # one StageRecord per stage, seq-ordered
    0001-iter1-reviewer.json
```

## Assumptions (question → answer → rationale)

- **run-id format?** → ISO timestamp (`:`/`.` → `-`) + `-<pid>` suffix →
  lexicographically sortable (so "latest" is a plain string sort) and
  collision-safe across concurrent runs on one host; no extra deps. `Date`/`pid`
  are injectable so tests are deterministic (product code, unlike workflow
  scripts, may call `new Date()`).
- **Is the stage list inside the manifest, or the directory?** → the `stages/`
  directory IS the list; the manifest does not duplicate it → avoids keeping two
  sources in sync; `readStageRecords` discovers them by sorted filename.
- **Where do bundles live — `.otto/` (tracked) or `.otto-tmp/` (ephemeral)?** →
  `.otto/runs/` like `state.json` → durable across the run, but git-ignored
  (a later task adds `.otto/runs/` to the workspace `.gitignore`, mirroring
  `.otto/state.json`). Raw `.otto-tmp/logs` behavior stays untouched (success
  metric 3).
- **Should task 1 touch the loop?** → no → keeping it inert means zero behavior
  change and a clean, isolated unit; loop wiring is task 2+.
- **Stage filename safety?** → sanitize the stage segment to `[A-Za-z0-9_-]` →
  panel lens names come from `OTTO_REVIEW_LENSES` (free text) and become a
  filename.

## Testing notes

`run-report.test.ts` (vitest), mirroring `state.test.ts`: round-trip manifest +
stage records through a temp dir; absent/malformed → null/empty (never throws);
`allocateRunId` is sortable + injectable + filesystem-safe; stage records sort
by seq and tolerate an unsafe stage name. Plus `pnpm -r typecheck`.
