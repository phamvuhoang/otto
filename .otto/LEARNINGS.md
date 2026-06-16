# Otto learnings

## Conventions

- **Sample/illustrative docs are anchored to their source-of-truth template, not
  hand-pinned.** `docs/quality-report-samples.md` ships filled-in example quality
  reports (one per mode); its doc-contract test `scripts/quality-report-samples.test.mjs`
  does NOT hardcode the expected section list — it PARSES the real contract
  (`templates/quality-report.md`): the six `## ` section headings, the bolded
  verdict vocabulary off the "One of — **…**" line, and the run modes off the
  `Mode: <a | b | …>` placeholder, then asserts every sample carries all six
  sections + a real verdict + a real mode. So a contract change forces the samples
  (and a one-line `deepEqual` sanity guard) to update instead of going stale —
  same drift-proofing philosophy as `security-doc-contract.test.mjs` parsing
  `stages.ts`/`runner.ts`. Splitting the doc into individual reports keys off the
  `# Otto quality report` H1 the contract emits. When adding a new mode/verdict to
  the contract, add a sample, don't just edit the test.
- **Review lenses are parametric + opt-in.** The panel renders any lens name from
  `OTTO_REVIEW_LENSES` into `review-lens.md` via `{{ LENS }}` — adding a lens is
  NOT a code change. Add one **definition bullet** to `review-lens.md`'s
  lens-description list (the reviewer reasons from it) and leave `DEFAULT_LENSES`
  in `run-bin.ts` (`correctness,security,tests`) untouched, so the new lens stays
  opt-in (`OTTO_REVIEW_LENSES=task-fit,…`) and augments rather than replaces the
  baseline. The `task-fit` lens ("did Otto solve the *right* problem / scope /
  reviewer-usefulness", distinct from correctness/security/tests) was added this
  way. Pinned by `review-lens.test.ts` (render-contract: definition present,
  baseline three still present, header wiring). NOTE: rendering `review-lens.md`
  in a test needs `spillHostDir`/`spillRefPath` opts (it uses `@spill?:head.diff`),
  unlike `apply-review.md`/`quality-report.md` which have no `@spill`.
- **Per-mode human-acceptance prompts** (Feature 2) live in a sibling fragment
  `templates/acceptance-prompts.md`, `@include`d ONCE at the tail of
  `quality-report.md`. Because every mode already includes the contract (directly
  for `verify.md`/`apply-review.md`, transitively via `ghprompt-workflow.md`
  FINISHING for the *afk* modes), the per-mode set reaches all of them through
  that single existing include — do NOT add a second include per template, and
  do NOT inline the prompts (same drift-proofing as the contract itself). The
  fragment has one `### <mode> — <name>` block per Mode (`afk` / `ghafk` /
  `linear-afk` / `apply-review` / `verify`) of task-fulfillment checkboxes that
  augment (not replace) the generic Human Acceptance Checklist. Pinned by
  `quality-report.test.ts`.
- The **Otto quality report contract** lives in one includable fragment
  `templates/quality-report.md` (Verdict / Task Source / What Changed / Evidence
  / Human Acceptance Checklist / Gaps And Follow-Ups; verdict = Accepted ·
  Accepted with follow-ups · Needs human review · Rejected, defaulting to *Needs
  human review* when unsure; tests are evidence, not the verdict). Any mode that
  emits a verification/completion summary (`verify.md` today; `ghafk`/`linear`
  completion + `apply-review` per the issue-19 roadmap) must
  `@include:quality-report.md` — never re-describe the shape inline, or the
  provider workflows drift (the same drift-proofing as `ghprompt-workflow.md` /
  `linear-completion.md`). Pinned by `quality-report.test.ts` render-contract.
  The single `@include:quality-report.md` for the completion handoff lives in the
  **shared `ghprompt-workflow.md` FINISHING section**, so the report *shape*
  reaches every `*afk*` mode (gh + linear) through one include — provider-mode
  fragments must NOT re-include it (that double-renders the contract). They only
  override **placement** (WHERE the report lands): `linear-completion.md` points
  it at the `otto-linear comment` body, GitHub uses the PR description / issue
  comment. Placement varies per provider; shape is included once upstream.
  **Two include classes, don't conflate them:** *afk* modes inherit the fragment
  transitively via the shared `ghprompt-workflow.md` FINISHING include (and must
  NOT re-include — double-render). **Standalone gate templates that do NOT
  `@include:ghprompt-workflow.md` — `verify.md` and `apply-review.md` — own their
  report and `@include:quality-report.md` *directly*.** apply-review emits it once
  in a `# COMPLETION REPORT` section gated to the final iteration (alongside the
  NO MORE TASKS sentinel, never per-iteration), mapping CONFIRMED-fixed→Evidence
  and deferred/won't-fix→Gaps. Pinned by `apply-review.test.ts`.
- `ghprompt-workflow.md` is **provider-agnostic** (RECONCILE → EXPLORATION →
  FEEDBACK → COMMIT → FINISHING → LEARNINGS, plus `@include:superpowers.md`). New
  provider-mode playbooks/templates (`linearprompt.md`, `linearafk-issue.md`,
  and any future `*afk*` mode) `@include:ghprompt-workflow.md` rather than
  forking the workflow — only the provider-specific issue-listing/selection prose
  differs per mode. The render-contract tests pin the include + the
  static-shell-tag invariant (no `{{ INPUTS }}` in a shell/@spill command body;
  only the validated `$OTTO_ISSUE` env var may appear).
- `--issue` parsing is **per-mode injectable**: `run-bin.ts`'s `RunBinConfig`
  carries an optional `parseIssue` (default `parseIssueRef` → GitHub number;
  `runLinearAfk` injects `parseLinearIssueArg` → Linear ref string), threaded
  into `parseFlags(argv, { parseIssue })`. `CliFlags.issue` is `number | string`
  accordingly, and `OTTO_ISSUE = String(flags.issue)` stays the shell-safe
  invariant because **every** `parseIssue` must emit only `[A-Za-z0-9-]` (the one
  ref fragment that reaches a host shell). A new provider mode adds its own
  validating `parseIssue`; it must not loosen that charset. Per-mode preflight
  rows hang off `opts.bin` in `runPreflight` (`otto-linear-afk` → `linear auth`
  via the injectable `linearAuth` probe), mirroring the `otto-ghafk` gh rows.
- Pure functions that touch the host (binary lookup, fs, credentials) take
  **injectable probes/deps** with host-wired defaults, so unit tests run without
  shelling out or hitting the real home dir. See `preflight.ts` (`runPreflight`
  probes) and `runner.ts`'s extracted argv builder.
- **Watch mode is per-mode injectable, like `parseIssue`.** `RunBinConfig`
  carries `supportsWatch`, `watchPoll` (poller, may be async), `watchProvider`
  (`{name, authCmd}` for the poll/auth lines), and `resolveWatchLabel` (which env
  var gates the run). Omitted → `runWatch`'s gh defaults (`pollOpenIssues`, `{gh,
  gh auth login}`, `OTTO_WATCH_LABEL`). `runWatch` **awaits** the poller so async
  pollers (Linear `fetch`) work; both pollers live in `watch.ts` and return the
  same `PollResult` (`pollOpenIssues` / `pollLinearIssues`), auth-classified so
  the daemon prints a re-login hint distinctly from a transient failure
  (`LinearApiError.kind === "auth"`). **Linear watch polls `OTTO_LINEAR_LABEL`
  (+`OTTO_LINEAR_TEAM`), not `OTTO_WATCH_LABEL`** — it must match the label its
  implementer selects, else watch never triggers when a user overrides the label.
  `printConfig`'s reported watch label mirrors this per-mode resolution.
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

- **Linear completion (move-to-done) is split: pure resolution in code, the
  comment-vs-move decision in the playbook.** `otto-linear done <ref>` resolves
  the target state via `resolveDoneState(states, OTTO_LINEAR_DONE_STATE)` (named
  state case-insensitively, else the first `type==="completed"` state by
  ascending `position`). When it can't resolve one it does **not** guess or move
  — it exits non-zero with a hint; the helper never auto-composes a comment.
  Which path to take (PR repo → comment + leave open; commit-to-branch → `done`)
  lives in the provider-specific `linear-completion.md` fragment, `@include`d by
  both `linearprompt.md` (multi-issue) and `linearafk-issue.md` (single-issue) —
  the same per-mode-prose-not-in-`ghprompt-workflow.md` convention as issue
  selection. Pin the fragment + its include with a render-contract assertion.

## Dead ends
