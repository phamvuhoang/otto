# Issue #45 — P6: Operator experience

## Problem

A maintainer running Otto AFK has the evidence substrate (run bundles under
`.otto/runs/`, the eval scorer, the adaptive router) but few concise operator
surfaces over it. `otto-inspect latest`/`<run-id>` already renders one run, but
there is no way to (a) list recent runs at a glance, (b) compare two existing
run bundles without the paid benchmark runner, or (c) see *why* the adaptive
router chose a review depth. The goal is a CLI-first operator view so users
trust AFK automation and debug failures without opening raw NDJSON.

## Approach

Surface existing pure substrate through thin, **read-only** operator commands,
each mirroring the established `otto-inspect` / `otto-memory` split: a pure
formatter (unit-testable, no I/O) + a thin `run*(argv, deps)` driver with
injectable `{env,cwd,out,err}`. No new run-time behavior, no loop regression.

- `otto-inspect latest` / `<run-id>` — **already works** (#39). Confirm + document.
- `otto-runs list` — new read-only bin over `listRunIds` + `readManifest`: a
  compact one-row-per-run summary table (newest first).
- `otto-eval compare <run-a> <run-b>` — new **non-paid** subcommand reading two
  existing run bundles, scoring each via `scoreTrajectory`, and printing the
  existing `compareTrajectories` table. Distinct from the paid benchmark runner.
- `--explain-routing` — new flag that enriches the adaptive router's per-iteration
  output with the full `RiskAssessment` (class/level/reasons) + chosen depth/lenses
  + the progress `PolicyDecision` reason, via a pure formatter. Meaningful only
  with `--adaptive-router` (the router only runs then); a no-op note otherwise.

## Assumptions

- **Q: New bin `otto-runs` vs. an `otto-inspect list` subcommand?** A: New
  `otto-runs` bin — the issue names it explicitly, and it keeps `otto-inspect`
  single-purpose (one run) vs. `otto-runs` (across runs). Mirrors `otto-memory`.
- **Q: Where does `compare` live?** A: A `compare` subcommand of `otto-eval`
  (the issue names `otto-eval compare`). It is read-only and free — it scores
  already-recorded bundles, never invokes a model — so it short-circuits before
  the paid suite path in `runEval`. `latest` resolves like `otto-inspect`.
- **Q: Does `--explain-routing` work without `--adaptive-router`?** A: No — there
  is no routing decision to explain when the router is off. The flag enriches the
  router's existing output; without the router it prints a one-line note and is
  otherwise inert. (A dry-run "what would route" mode is out of scope, YAGNI.)
- **Q: New runtime behavior?** A: None. Every command is read-only over recorded
  bundles; `--explain-routing` only changes what the loop *prints*, never what it
  does. So no success metric (PR-handoff, no-NDJSON inspection) risks a regression.

## Testing notes

- `runs-cli.test.ts`: pure `formatRunsList(summaries)` (empty → "no runs",
  columns, newest-first, running vs. finalized); `runRuns(argv, deps)` with
  injected `listRunIds`/`readManifest` (absent dir → friendly message, help).
- `eval-run.test.ts`: `compare` subcommand — two ids → table via injected
  readers; `latest` resolution; missing bundle → exit 1; arg validation.
- `risk.test.ts`: pure `explainRouting(route, decision?)` formatter (reasons,
  depth/lenses, policy reason, no-decision case).
- `cli-help.test.ts`: `--explain-routing` parse + `--print-config` line.

## Plan slices (see plan.md)
