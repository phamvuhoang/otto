# Fixture: fanout-overlap (P25 Task 8)

Exercises `--fan-out`'s conflict-aware scheduling (P25) when a plan declares
two `parallelSafe` tasks whose `fileScope` **overlaps by directory**, instead
of the disjoint-scope happy path the original P11 fan-out shipped with.

## The overlap

`.otto/tasks/fanout-overlap/tasks.json` declares two tasks:

- `add-price-formatter` — scope `src/widgets/` (the whole directory):
  implement `formatPrice(cents)` in `src/widgets/format.mjs` so
  `format.test.mjs` passes.
- `verify-price-formatter` — scope `src/widgets/format.mjs` (a single file
  nested under the first task's directory, so it **collides** with
  `add-price-formatter`'s scope via `pathsCollide`'s directory-prefix rule):
  re-confirm the same file's `formatPrice` is correct.

Because the scopes collide, `planParallelGroups` (packages/core/src/plan-tasks.ts)
never schedules them into the same wave — `add-price-formatter` lands first
(wave 1); `verify-price-formatter` runs alone in wave 2, starting from the
already-updated worktree. Since `add-price-formatter` already satisfies what
`verify-price-formatter` asks for, its sub-agent has nothing left to commit —
the expected outcome is **one task landed, one task deferred** (`"no commit
produced"` or an equivalent reason), the case P25's conflict-aware scheduler
is designed to isolate rather than let race destructively.

## What the check inspects

`check-fanout.mjs` reads the fixture's latest `.otto/runs/<id>/manifest.json`
and asserts the `fanout.contributions` evidence (P25 Task 4,
`packages/core/src/run-report.ts`'s `RunManifest["fanout"]`) has exactly one
entry with `status: "landed"` and exactly one with `status: "deferred"` that
carries a `reason`.

## Running the paid suite

Registered in `benchmarks/suite.json` with `"args": ["--fan-out"]` on the
task itself, so `--fan-out` runs under every config in `configs.json`
(including the plain `baseline` config) — the `fanout-hardened` config
(`{ "args": ["--fan-out"] }`) exists separately to A/B `--fan-out` across the
_rest_ of the suite. Like the rest of the benchmark suite, this fixture's
real signal requires an actual model run and is **not** part of CI (see
`benchmarks/README.md`); it is validated in CI only structurally (the fixture
exists, the suite entry has a well-formed expectation).
