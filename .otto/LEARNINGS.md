# Otto learnings

## Conventions

- Pure functions that touch the host (binary lookup, fs, credentials) take
  **injectable probes/deps** with host-wired defaults, so unit tests run without
  shelling out or hitting the real home dir. See `preflight.ts` (`runPreflight`
  probes) and `runner.ts`'s extracted argv builder.
- Every terminal exit path in `loop.ts` funnels through one `summarize(reason,
  iterations)` helper that prints a single consistent stdout line (`● Otto
  <reason> · N iterations · $cost`). When adding a new exit reason, call
  `summarize` rather than emitting a bespoke line. Summary/completion lines write
  to **stdout** and must use the `*Out` color helpers (`greenOut`/`boldOut`/
  `dimOut`, gated by `USE_COLOR_STDOUT`), never the stderr-gated `red`/`bold`/
  `dim` — otherwise ANSI leaks into redirected stdout.

## Gotchas

- The SIGINT/SIGTERM handlers in `loop.ts` call `process.exit()`, which runs
  **synchronously** and pre-empts pending promise `finally` blocks — so the
  per-stage scratch cleanup in `runner.ts`/`panel.ts` never runs on interrupt.
  Anything that must happen on the interrupt path (wake-lock release, scratch
  sweep via `cleanScratch`) has to be invoked **synchronously** in the handler
  before `process.exit()`, not deferred to a `finally`.

## Decisions

- `--print-config` prints two blocks: the resolved config, then a **preflight**
  block (`runPreflight`) diagnosing run prerequisites (claude CLI/auth, git
  workspace; gh CLI/auth only for `otto-ghafk`). It reports only — never exits
  non-zero — because the flag is a read-only diagnostic.

## Dead ends
