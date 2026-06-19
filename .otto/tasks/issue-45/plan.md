# Issue #45 plan — Operator experience

Each slice is one commit. Read-only operator surfaces over existing substrate;
no loop-behavior change (so no run can regress). Mirrors the `otto-inspect` /
`otto-memory` pure-formatter + thin-driver split.

- [ ] **1. `otto-runs list`** — pure `formatRunsList(summaries)` + thin
      `runRuns(argv, deps)` in `runs-cli.ts` (injectable `{env,cwd,out,err}` +
      `listRunIds`/`readManifest`), new `apps/cli/bin/otto-runs.js` + package.json
      `bin` entry, exported from `index.ts`. Pinned by `runs-cli.test.ts`.
- [ ] **2. `otto-eval compare <run-a> <run-b>`** — a read-only, non-paid `compare`
      subcommand in `eval-run.ts`: resolve two run ids (incl. `latest`), read +
      `scoreTrajectory` each, print `compareTrajectories`; missing bundle → exit 1.
      Short-circuits before the paid suite path. Pinned by `eval-run.test.ts`.
- [ ] **3. `--explain-routing`** — pure `explainRouting(route, decision?)` formatter
      in `risk.ts`; `--explain-routing`/`OTTO_EXPLAIN_ROUTING` flag in `cli-help.ts`
      threaded through `run-bin.ts` → `runLoop` (`explainRouting` option). In the
      loop's adaptive-router block, when on, print the detailed explanation; a note
      when the router is off. Pinned by `risk.test.ts` + `cli-help.test.ts` +
      `loop.test.ts`.
- [ ] **4. Docs** — README (Why Otto operator bullet + the new commands in the
      examples/How-it-works), `docs/CLI.md` (`otto-runs`, `otto-eval compare`,
      `--explain-routing`), `docs/ARCHITECTURE.md` (`runs-cli.ts` module-map row +
      an Operator surfaces note). `otto-inspect latest` documented as already working.
