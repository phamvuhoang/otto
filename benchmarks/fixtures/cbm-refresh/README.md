# Fixture: cbm-refresh (P26 slice 2)

Measures whether codebase-memory's **refresh-before-review** wiring (P26
slice 2 Task 5: preflight index, refresh before the review stage) lets the
reviewer see a caller graph edge that only exists _after_ the implementer's
edit — versus a stale index (or no index at all) that still reflects the
pre-edit graph.

## The renamed symbol + new caller

- `policy.mjs` exports `retryDelayMs(attempt)`, the shared backoff policy —
  today nothing calls it.
- `alerts.mjs`'s `scheduleAlertRetry` duplicates its own backoff math instead
  of reusing the shared policy.
- The benchmark task asks the agent to **rename** `retryDelayMs` to
  `computeBackoffMs` in `policy.mjs` and wire `alerts.mjs` to call it,
  deleting the duplicated math.

That edit does two things at once: it renames the symbol _and_ creates a
brand-new caller edge (`alerts.mjs` → `policy.mjs`). An index built before the
edit still has the old symbol name with its old (empty) caller set — it does
not know `alerts.mjs` depends on `policy.mjs` at all. Only a refreshed index,
built after the implementer's commit and before the reviewer stage runs, shows
the new edge.

## Known impact

`impact.json` lists the two files a correct answer should name when asked
"what does the backoff-policy rename impact?": `policy.mjs` itself and
`alerts.mjs`, its new caller. `scoreImpactRecall(knownImpactedFiles,
answerText)` (in `packages/core/src/eval.ts`) scores an agent's answer against
this list the same way it does for `cbm-cross-module` — 1.0 if both paths
appear in the answer text, 0.5 if only one does.

## Pass condition

Rename `retryDelayMs` in `policy.mjs` to `computeBackoffMs` and use it from
`alerts.mjs`'s `scheduleAlertRetry` instead of its duplicated backoff math.
`node --test` is green when the rename and the new caller wiring are both
correct (see `alerts.test.mjs`).

## Running the paid suite

Registered in `benchmarks/suite.json` with `"args": ["--enable-tool",
"codebase-memory"]` and `"env": { "OTTO_CBM_E2E": "1" }` on the task itself,
matching the `cbm-inject`/`cbm-on` configs in `benchmarks/configs.json` so the
tool is active under every config that also sets those. As with the rest of
the benchmark suite (`benchmarks/README.md`), this fixture's real signal —
does codebase-memory's refresh-before-review wiring raise `impactRecall` on
the _new_ caller edge versus `cbm-off` or a stale/no-refresh index — requires
an actual model run and is **not** part of CI; it is validated in CI only
structurally (the fixture exists, the suite entry has a well-formed
expectation, `node --test` fails on the unfixed tree and passes once the
rename + rewiring lands).

**Model-dependent outcome:** whether codebase-memory's refresh actually beats
a stale/no-index baseline on this task depends on the model under test and is
not guaranteed by the fixture alone — the fixture only guarantees the
underlying graph fact (a genuinely new caller edge) exists to be found.
