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
- Otto-on-Otto changes ship as a **PR**, not loose commits. Each review round
  commits `fix(review): …` onto the **same** `otto/<n>` feature branch (never a
  side review branch — that strands the canonical branch and splits history);
  the open PR just re-shows the updated diff for the next round. When
  implementation + all review rounds are done: push `otto/<n>`, open/refresh the
  PR into `main`. Merging it makes release-please open/refresh the
  `release-please--branches--main` PR, which is merged **manually** to publish to
  npm. Before opening, sanity-check the implied bump — pre-1.0 `feat`→minor,
  `fix`→patch, and the `node-workspace` plugin patch-bumps the CLI (and rewrites
  its dep range) whenever `otto-core` bumps. Never hand-edit versions;
  release-please owns them — use a `Release-As:` footer to override.

## Gotchas

- The release smoke (`scripts/smoke-pack-install.mjs`) must pass `--cache <dir>`
  to its `npm install`: the default shared `~/.npm/_cacache` is outside the
  sandbox write-allowlist (only `~/.npm/_logs` is writable) and is also commonly
  root-owned, so an install there fails `EPERM mkdtemp`. A per-run cache under the
  throwaway work dir keeps the install hermetic and sandbox-safe. Both otto
  packages are dependency-free except the CLI→core workspace link, so installing
  the two local tarballs together resolves fully `--offline`.
- The SIGINT/SIGTERM handlers in `loop.ts` call `process.exit()`, which runs
  **synchronously** and pre-empts pending promise `finally` blocks — so the
  per-stage scratch cleanup in `runner.ts`/`panel.ts` never runs on interrupt.
  Anything that must happen on the interrupt path (wake-lock release, scratch
  sweep via `cleanScratch`) has to be invoked **synchronously** in the handler
  before `process.exit()`, not deferred to a `finally`.
- vitest v4 gotcha: calling `mockReset()` on a `vi.fn()` and then giving it a
  throwing `mockImplementation(() => { throw … })` makes the (otherwise caught)
  throw surface as an *unhandled* error and fail the test — even though the code
  under test catches it correctly. Don't `mockReset()` a mock you're about to
  hand a throwing impl; set the impl fresh each test instead (it overrides the
  prior one, so no reset is needed). See `watch.test.ts` `pollOpenIssues` cases.

## Decisions

- `--print-config` prints two blocks: the resolved config, then a **preflight**
  block (`runPreflight`) diagnosing run prerequisites (claude CLI/auth, git
  workspace; gh CLI/auth only for `otto-ghafk`). It reports only — never exits
  non-zero — because the flag is a read-only diagnostic.

## Dead ends
