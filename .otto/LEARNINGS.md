# Otto learnings

## Conventions

- `ghprompt-workflow.md` is **provider-agnostic** (RECONCILE → EXPLORATION →
  FEEDBACK → COMMIT → FINISHING → LEARNINGS, plus `@include:superpowers.md`). New
  provider-mode playbooks/templates (`linearprompt.md`, `linearafk-issue.md`,
  and any future `*afk*` mode) `@include:ghprompt-workflow.md` rather than
  forking the workflow — only the provider-specific issue-listing/selection prose
  differs per mode. The render-contract tests pin the include + the
  static-shell-tag invariant (no `{{ INPUTS }}` in a shell/@spill command body;
  only the validated `$OTTO_ISSUE` env var may appear).
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
- **Definition of done (Otto-on-Otto): a run is NOT finished until the PR
  exists.** Local commits on `otto/<n>` are *not* "shipped" — leaving work as
  local-only commits and declaring the issue done is the failure mode to avoid.
  The last step every otto-on-otto run must reach is: **push `otto/<n>` to origin
  and `gh pr create` (or refresh an existing PR) into `main`, then confirm the PR
  URL.** The GitHub issue stays OPEN and closes only when that PR merges. Each
  review round commits `fix(review): …` onto the **same** `otto/<n>` branch
  (never a side review branch — that strands the canonical branch and splits
  history); the open PR re-shows the updated diff for the next round. Merging the
  PR makes release-please open/refresh the `release-please--branches--main` PR,
  which is merged **manually** to publish to npm. Before opening, sanity-check the
  implied bump — pre-1.0 `feat`→minor, `fix`→patch, and `node-workspace`
  patch-bumps the CLI (rewriting its dep range) whenever `otto-core` bumps. Never
  hand-edit versions; release-please owns them — use a `Release-As:` footer to
  override.
  - This PR-completion gate is **specific to this repo** (otto-on-otto). When
    Otto runs against a *different* repo, the definition of done follows **that
    repo's** `.otto/LEARNINGS.md` / conventions — don't assume a PR is wanted
    there; do what that repo's learnings say (commit-only, PR, etc.).

## Gotchas

- Linear's GraphQL API authenticates a **personal API key** with a bare
  `Authorization: <key>` header — **no `Bearer` prefix** (that prefix is for
  OAuth access tokens only). `createLinearClient` in `linear-api.ts` sets the
  header verbatim; getting this wrong yields a 401 that `LinearApiError`
  classifies as `kind: "auth"`. Endpoint is `https://api.linear.app/graphql`.
- Root contract tests (`scripts/*.test.mjs`, run by `pnpm test` → CI's "Root
  contract tests" step) are wired via a **glob**, not an explicit file list. An
  earlier explicit list silently dropped new contract tests
  (`contributing-extension-points`, `cli-docs-recipes`) so they never ran in CI
  despite passing locally. Keep the glob; a new `scripts/<x>.test.mjs` auto-runs.
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

- Agent-driven behaviors with no otto code behind them (e.g. apply-review's
  follow-up trail — nothing in src writes `.otto/review-followups.md`, the
  `apply-review.md` template both surfaces the existing trail and instructs the
  agent to append + commit it) are tested at the **template/render-contract**
  level: render the template into a temp workspace and assert the renderer
  surfaces the file (present → inlined, absent → `!?` fallback) plus pin the
  instruction strings. See `apply-review.test.ts` / `superpowers-include.test.ts`.

## Dead ends
