# Otto learnings

## Conventions

- **Governed memory (#42 P3) — `memory.ts` + `memory-cli.ts`, modelled on
  `run-report.ts`; full design in `docs/ARCHITECTURE.md` "Governed memory
  lifecycle".** Records are one JSON file per id under `.otto/memory/<id>.json`
  (git-tracked, the **directory IS the list**, no index). Durable gotchas:
  **three orthogonal axes — `trust` (provenance) vs `confidence` (scalar) vs
  `status` (lifecycle) — don't collapse them.** Freshness is **DERIVED, not
  stored** (`memoryStatus`): stale once past `expiresAt` (inclusive) or
  `revalidateAfterDays` since `lastUsedAt ?? createdAt`, EXCEPT `superseded`
  which is terminal; **unparseable timestamps are ignored, never staled** (to
  test that path corrupt BOTH `lastUsedAt` AND `createdAt`, else the
  `createdAt` fallback drives it). `auditMemory` mixes status on purpose —
  `stale[]`/counts use DERIVED status, `conflicting[]` (`detectConflicts`)
  uses STORED status; **don't "fix" the asymmetry.** `counts.conflicting` is
  PAIRS; `frequentlyUsed` is status-independent (a stale/superseded record can
  still be frequent). All helpers are PURE (return copies, never mutate); all
  readers never throw (absent/malformed → safe `null`/`[]`). Pinned by
  `memory.test.ts` / `memory-cli.test.ts` / `governed-memory.test.ts`.
- **Memory is INERT on the READ path by design (#42).** `projectLearnings`
  renders only DERIVED-active records into the canonical four-section
  `# Otto learnings` view (carrying NO governance metadata — that stays in
  `otto-memory audit`); `otto-memory project` prints it **raw, no header
  line**, so `otto-memory project > .otto/LEARNINGS.md` is a clean redirect —
  but it is **NOT auto-run** (would clobber the hand-curated LEARNINGS superset).
  The loop still injects `LEARNINGS.md` verbatim via `cat`; records are
  written by the shared `templates/governed-memory.md` fragment (`@include`d
  ONCE in BOTH playbook LEARNINGS sections — `prompt.md` + `ghprompt-workflow.md`,
  disjoint per rendered prompt) and read only by the read-only `otto-memory`
  bin, so a memory read can't regress a run. Issue #42 COMPLETE (slice 7 = docs;
  prose-only, no doc-contract test — low drift, substrate already unit-pinned).
- **Harness eval (#40 P1) — `eval.ts`, pure scoring over the #39 bundle; design
  in `docs/ARCHITECTURE.md`.** `scoreTrajectory` derives only
  TRAJECTORY-computable signals (no I/O, no model — the CI-safe subset);
  fixture-derived signals (tests-passed/diff) are the runner's job. `elapsedMs`
  is `null` never NaN when un-finalized/unparseable. `succeeded` deliberately
  EXCLUDES "done with failures" (matches the loop's `sawFailure`).
  `compareTrajectories` marks best/worst only on DIRECTIONAL signals and only
  with a real spread (≥2 comparable, min!==max); numbers render EXACT (no
  rounding) so a marked-best never displays equal to a marked-worst. Pinned by
  `eval.test.ts`.
- **Run evidence bundle (#39 P0) — `run-report.ts` + `otto-inspect`; design in
  `docs/ARCHITECTURE.md` "Run evidence bundle".** `.otto/runs/<run-id>/` =
  `manifest.json` + per-stage records under `stages/`; **the `stages/`
  DIRECTORY IS the list — the manifest never duplicates it.** `allocateRunId` is
  a sortable ISO stamp + pid, so "latest" = `listRunIds().at(-1)` (plain string
  sort). Durable gotchas: the manifest is finalized INSIDE the single
  `summarize` helper (one call site, not per return), and finalize +
  `recordStage` are **try/catch-swallowed — a bundle write must NEVER break a
  run**; `recordStage` captures `startedAt` BEFORE the retry loop and the GATE
  stage is recorded BEFORE the sentinel early-return; a panel records its
  substages by LENS NAME (not an umbrella "reviewer" record). **Known gap: the
  `process.exit` interrupt paths (SIGINT/SIGTERM) leave only the un-finalized
  initial manifest** (no synchronous finalize in `gracefulExit`).
  `StageRecord.logPath` is left undefined (its filename embeds a fresh `Date`,
  so re-deriving wouldn't match). Pinned by `run-report.test.ts` /
  `inspect.test.ts` / `loop.test.ts`.
- **Agent runtime abstraction (#24) — `agent-runtime.ts` + the `runner.ts`
  `AgentRuntime` adapter; design in `docs/ARCHITECTURE.md`.** Everything
  Claude-specific lives behind an `AgentRuntime` object; `claudeRuntime` is the
  sole shipped adapter and `getAgentRuntime("codex")` **throws "not
  implemented"**. **Test gotcha: any test that `vi.mock("../runner.js")` must
  ALSO stub `getAgentRuntime`** (a `(id)=>({id})` stub) or `executeStage`
  throws on the undefined import. Selection precedence is flag→env→config→default;
  a resolved non-claude id is reported by `--print-config` (read-only, exit 0)
  but **fatal on a real run** until the adapter ships. Auto-switch-on-limit: **ONE
  switch only** (inside the rate-limit catch, AFTER the accounting rollback so
  budget survives); `RunState.agent` persists the active runtime, `--fresh`
  resets to primary; the fallback agent has **NO default** (switching providers
  must be explicit). `resolveModelSelection` picks `OTTO_<RUNTIME>_MODEL` over
  `OTTO_MODEL` (empty falls through). Rate-limit detection stays GENERIC (not
  behind the adapter — YAGNI until a second runtime's signal shape is known). The
  runtime suffixes the NDJSON log filename (`-claude.ndjson`) ALWAYS —
  "byte-for-byte Claude" is about spawned CLI args/output, not artifact filenames.
  **Codex specifics (from the spike, schema still UNVERIFIED): no USD cost (budget
  reads $0), no `--settings` sandbox (its own `--sandbox … --ask-for-approval
  never`, so `supportsSandboxSettings:false`), auth `~/.codex/auth.json` OR
  `OPENAI_API_KEY`, preflight probes `codex --version` (the npm shim is on PATH
  even when its native binary is broken).** Pinned by `agent-runtime.test.ts` /
  `runner.test.ts` / `cli-help.test.ts` / `loop.test.ts` / `run-bin.test.ts`
  / `preflight.test.ts`.
- **Branch convention vs. branch prefix (`--branch-convention`, issue #21 P2)** —
  there are now TWO branch-namespace flags and the newer one is canonical. The
  pre-existing `--branch-prefix`/`OTTO_BRANCH_PREFIX`/`config.branchPrefix` is a
  **raw** string concatenated to the slug (no validation, no separator — `feat`
  → `featslug`). `--branch-convention`/`OTTO_BRANCH_CONVENTION`/
  `config.branchConvention` is the **validated, slash-normalized** namespace via
  `normalizeBranchConvention(raw)` in `branch.ts` (trim → strip trailing `/+` →
  reject non-git-ref-safe segments: whitespace, `..`, leading `-`/`.`, empty
  interior segment, `.lock` suffix, ref metacharacters → return `<conv>/`). So
  `feat` and `feat/` both yield `feat/`. They coexist (prefix kept for
  back-compat); `resolveBranch` precedence is **flagConvention → flagPrefix →
  config.branchConvention → config.branchPrefix → otto/** (flags beat config,
  convention beats prefix at each level). Default `otto` normalizes to the same
  `otto/` the old `DEFAULT_PREFIX` used, so behavior is unchanged when neither is
  set. `--print-config` shows `branch <strategy> (convention "<c>")` when a
  convention is set, else the prefix form. **Still deferred:** the branch SLUG is
  still `slugify(inputs)`, NOT `deriveTaskKey` — wiring the full
  `<convention>/<task-key>` needs the P2/P4 legacy-path fallback (same reason P0
  left the key helper inert), so the convention namespace shipped without the
  task-key swap. Validation is a pure regex (not a `git check-ref-format` spawn in
  the hot path), but the resolveBranch tests prove safety by actually creating the
  branch via `git switch -c`. Pinned by `branch.test.ts`
  (`normalizeBranchConvention` + `resolveBranch` convention cases) and
  `cli-help.test.ts` (parseFlags + print-config). Design-ordering call: this
  shipped before the still-unchecked "remaining artifacts" P2 item because that
  item is design-blocked (followups) and this one is not.
- **Task-local follow-ups (`.otto/tasks/<task-key>/followups.md`, issue #21 P2)** —
  the apply-review follow-up trail moved from the flat global
  `.otto/review-followups.md` to the task-grouped layout, beside spec/plan.
  Template-driven (`apply-review.md`), no otto code. The "no task-key source for
  apply-review" blocker that deferred this 3× is resolved by **deriving the key from
  the current git branch's final path segment** (`git branch --show-current` →
  part after the last `/`): apply-review always runs on the task branch
  `<convention>/<slug>`, so the branch IS the task-key source — resolved by the
  agent in prose (NO shell tag, so Windows-safe; mirrors how `superpowers.md`
  resolves its key). "Globally summarizable" (the issue's other requirement) is met
  by the globbable `.otto/tasks/*/followups.md` path, not by re-aggregating into one
  file. WRITE new task-local; the legacy global is still READ-as-fallback for one
  release (new writes never go there). **Scope call: only follow-ups moved**, because
  it is the ONLY one of the four named "remaining artifacts" actually persisted as a
  flat `.otto/` file today — `reviews/` go to a temp `FINDINGS_DIR` (panel), the
  quality-report is emitted to the PR/issue-comment by the contract (not a file), and
  `metadata.json` has no producer/consumer (speculative → YAGNI, dropped). Pinned by
  `apply-review.test.ts` ("records follow-ups under the task dir": branch-derived key,
  task-local write path, the `*` glob, legacy-read fallback). The remaining P2 items
  on the plan are now closed by this slice; only P4 (docs/migration) is left open.
- **Task-grouped artifact layout (`.otto/tasks/<task-key>/`, issue #21 P2)** is
  template-driven, NOT code: no otto src writes spec/plan — the `superpowers.md`
  workflow prose tells the agent where to put them, so the layout change is a
  template edit pinned at the render-contract level (`superpowers-include.test.ts`:
  new WRITE paths `.otto/tasks/<task-key>/{spec,plan}.md` present AND the legacy
  flat paths still present as the CLARITY GATE READ fallback). Two non-obvious
  rules: (1) **WRITE new, READ legacy-as-fallback** — the gate checks
  `.otto/tasks/<task-key>/spec.md` first, then `.otto/specs/<task-key>-design.md`,
  so an in-flight roadmap created under the old layout keeps going without
  re-brainstorming. (2) **Do NOT migrate existing `.otto/specs|plans/*` files**
  when changing the template: template edits only affect FUTURE otto versions, but
  the currently-installed otto driving the live run still reads the flat layout —
  moving the files would break the running daemon mid-roadmap. The legacy-read
  fallback does the migration safely on the next release instead. Scope was the
  **spec/plan** slice only; reviews/followups/quality-report/metadata are a
  separate task (followups need a per-item-task-local-but-globally-summarizable
  design call + a task-key source for `apply-review.md`, which has none today).
- **Linear project scope (`OTTO_LINEAR_PROJECT` / `otto-linear --project`, issue
  #21 P1)** mirrors the team filter, NOT the GitHub `--repo` shape: a project name
  is human-friendly free text (`"Roadmap Q3"`) that only ever reaches Linear's
  GraphQL `IssueFilter` (`project: { name: { eq } }` in `listIssues`), never a host
  shell — so it needs **no `parseGithubRepo`-style charset validation and no
  template interpolation**. Like team, the linear templates DON'T pass `--project`
  in the command body; `otto-linear list/dump` read `OTTO_LINEAR_PROJECT` from the
  inherited env inside `listOptions`, and `runLinearAfk`'s `watchPoll` reads the
  same env into `pollLinearIssues` (`LinearPollDeps.project`). Project names aren't
  unique across teams (issue risk note), so a project filter is meant to be paired
  with `OTTO_LINEAR_TEAM`; we still match on name to keep CLI input friendly.
  Pinned by `linear-api.test.ts` (filter present/absent), `linear-cli.test.ts`
  (flag + env defaulting), `watch.test.ts` (poll forwards project). The
  `otto-linear-afk --project` flag + `--print-config` scope display is the
  run-bin/`supportsProjectScope` half (mirrors `supportsRepoScope`, set on
  linear-main only): `parseFlags` captures raw `flags.project` (free text — NO
  charset validation / no `scopeError` path, unlike `--repo`, because it only
  reaches Linear's GraphQL filter, never a host shell); run-bin resolves
  `flags.project ?? OTTO_LINEAR_PROJECT` **plus** `OTTO_LINEAR_TEAM` into a linear
  `WorkScope`, **re-exports `process.env.OTTO_LINEAR_PROJECT`** so the flag (not
  just the env var) reaches the `otto-linear list/dump` templates and the watch
  poller, and threads `scope` into `runWatch`/`describeScope`. Build the scope
  when **team OR project** is set (a team-only scope is still reported), so
  `--print-config` shows `linear team:ENG project:Roadmap Q3`. `--project` on a
  non-linear bin errors. The unified run-bin `scope` var (was `githubScope`)
  carries either provider's scope. Pinned by `cli-help.test.ts` (`parseFlags
  --project`); the scope wiring mirrors the (integration-untested, parts-tested)
  `--repo` path. Like the `--repo` commit, comprehensive README/CLI.md docs are
  deferred to P4 — only `cli-help.ts` help text + print-config were touched.
- **GitHub watch scope (`--repo`/`OTTO_GITHUB_REPO`, issue #21 P1)** threads a
  validated repo end-to-end without breaking the host-shell RCE invariant. The
  raw `--repo` value is captured untyped in `parseFlags` (`flags.repo`); run-bin
  resolves `flags.repo ?? (OTTO_GITHUB_REPO env || undefined)` through
  `parseGithubRepo` (in `task-key.ts`, charset-validated → shell-safe `owner/repo`,
  case preserved) into a `WorkScope`, then **re-exports the canonical owner/repo
  as `process.env.OTTO_GITHUB_REPO`**. The ghafk templates consume it with the
  **opt-in shell guard** `${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"}` — empty/unset
  expands to nothing (default = workspace repo), set → `--repo owner/repo`; this
  preserves the "existing behavior is the default" criterion with no per-call
  conditional in code. `render.ts`/`runner.ts` use `execSync`/`spawn` with NO
  explicit `env`, so the value inherited from `process.env` reaches BOTH the
  render-time `gh issue list/view` shell tags AND the spawned claude agent (whose
  completion `gh` commands the prose tells it to scope). So now **TWO** validated
  env vars may appear in a shell/spill tag body — `$OTTO_ISSUE` and
  `$OTTO_GITHUB_REPO` — pinned by `ghafk-templates.test.ts` (mirror of
  `linear-templates.test.ts`: RCE `{{` invariant + allowed-env-ref set). Gating:
  `RunBinConfig.supportsRepoScope` (otto-ghafk only); `--repo` on another bin
  errors; an invalid repo is **fatal on a real run but only reported (exit 0)
  under `--print-config`** (the read-only-diagnostic contract). `pollOpenIssues`
  takes an optional 3rd `repo` arg (`gh issue list --repo`); `runWatch` derives it
  from `scope` and prefixes every poll line with `describeScope(scope)`. The
  Linear `--project` P1 item should mirror this shape.
- **GitHub multi-target watch (`--repo` repeatable / `OTTO_GITHUB_REPOS`, issue
  #21 P3)** layers on the P1 single-target shape WITHOUT forking it. `parseFlags`
  now **accumulates** repeated `--repo` into `flags.repos: string[]` (no longer
  overwrites); `flags.repo` is kept = `repos[0]` so every single-target caller is
  untouched. run-bin merges `flags.repos` (or, if empty, the comma-list
  `OTTO_GITHUB_REPOS`, or the single `OTTO_GITHUB_REPO`) through `parseGithubRepo`
  into a github `WorkScope[]`: **exactly one → the unchanged single-target path**
  (`scope` set + `OTTO_GITHUB_REPO` exported); **>1 → `scopes` passed to
  `runWatch`, and NO single `OTTO_GITHUB_REPO` is pinned** (the daemon pins it
  per-cycle). `runWatch` takes `scopes?: WorkScope[]`, normalizes to
  `scopeList = scopes?.length ? scopes : [scope]` (a lone `undefined` = workspace
  default), and each cycle **polls every scope, runs ONE loop for the first scope
  with work, then breaks back to the sleep+repoll** (one loop at a time → no
  parallel workspace mutation). The confinement crux: before that loop it sets
  `process.env.OTTO_GITHUB_REPO = sRepo` for the selected scope (the inherited-env
  trick from P1 is how the templates/agent get scoped — there is no per-loop
  `env` arg). A `!poll.ok` scope is logged (`describeScope`-prefixed) and
  `continue`d so it **never blocks the others** (P3 failure-isolation criterion);
  idle prints once only when `allIdle && !ran`. One cumulative budget spans all
  scopes (unchanged). `--print-config`/the watch banner list every scope
  (`scopes.map(describeScope).join(", ")`). Pinned by `cli-help.test.ts` (repeated
  `--repo` → `repos`) + `watch.test.ts` (`multi-target (scopes)`: polls each,
  runs first-with-work + env-pin, failure-isolation). The Linear repeatable
  `--project` mirror shipped (next bullet); the `<task-key>` branch/artifact half
  stays blocked on the legacy-read (P2/P4).
- **Linear multi-target watch (`--project` repeatable / `OTTO_LINEAR_PROJECTS`,
  issue #21 P3)** mirrors the GitHub `--repo` multi-target shape but confines
  scopes a DIFFERENT way. `parseFlags` accumulates repeated `--project` into
  `flags.projects` (`project` kept = `projects[0]`, single-target callers
  untouched); run-bin's `supportsProjectScope` merges `flags.projects` (or the
  comma-list `OTTO_LINEAR_PROJECTS`, or the single `OTTO_LINEAR_PROJECT`) into a
  linear `WorkScope[]` — **each project pairs with the same `OTTO_LINEAR_TEAM`**;
  one → the unchanged single-target path (`scope` set + `OTTO_LINEAR_PROJECT`
  exported), >1 → `scopes` to `runWatch` (no single value pinned). The crux that
  differs from GitHub: the GitHub poller takes a `--repo` poll **arg**
  (`ghRepoOf(s)`), but the **Linear poller reads `OTTO_LINEAR_PROJECT` from the
  inherited env** (the `watchPoll` closure in `linear-main.ts`), so `runWatch`
  must **pin `process.env.OTTO_LINEAR_PROJECT = sProject` BEFORE the poll** (not
  just on the run, like GitHub's `OTTO_GITHUB_REPO`) — `linearProjectOf(s)` does
  the per-scope lookup. Pinning before the poll confines BOTH the poll and the
  subsequent loop (the loop's templates inherit the same env). No charset
  validation (project is GraphQL-only free text, never a host shell — unlike
  `--repo`). Pinned by `cli-help.test.ts` (repeated `--project` → `projects`) +
  `watch.test.ts` (`multi-target Linear (scopes)`: env pinned per poll, names
  each scope, runs first-with-work confined). **Test trick:** since the Linear
  poller is the same mocked `pollIssues(label, cwd, repo)` with `repo=undefined`,
  assert confinement by capturing `process.env.OTTO_LINEAR_PROJECT` inside the
  mock impl, not via a poll arg. Like the GitHub P3 commit, comprehensive
  README/CLI.md docs are deferred to P4 (only `cli-help.ts` help/env text +
  print-config touched).
- **Work scope + task key contract** (issue #21, P0) lives in one pure module
  `task-key.ts`, split into TWO types on purpose: `WorkScope` = *where* Otto may
  look (provider + owner/repo or team/project, NO item) for watch + `--print-config`;
  `WorkSource` = a scope PLUS the concrete item (issue/slug) that names artifacts +
  branches. `deriveTaskKey(source)` emits the one normalized key
  (`plan-<slug>` / `gh-<owner>-<repo>-<issue>[-<slug>]` / `linear-<team>-<project>-<issue>[-<slug>]`,
  optional parts dropped when absent); `describeScope(scope)` is the human one-liner
  the caller suffixes with `label:` etc. Every free-text part goes through the same
  sanitizer as `slugify` (lowercase, non-`[a-z0-9]`→`-`, trim) so keys are BOTH
  filesystem-safe and git-branch-safe; slugs cap at 40. **Test branch-safety
  against real git** (`git check-ref-format --branch <key>` and `<convention>/<key>`),
  not a regex. The helper is INERT until P1–P4 wire it in (swapping today's
  `issue-<n>` task-key needs the legacy-path fallback from P2/P4), so adding it
  can't regress existing behavior. Pinned by `task-key.test.ts`.
- **Cross-run quality summary vs. per-run report — keep them apart.** A rollup
  *across* runs (per-verdict tally, common rejection/follow-up causes, still-open
  gaps/deferred) is NOT a per-run artifact, so it does **not** belong in the
  shared `quality-report.md` contract (and a new `## ` there would break the
  six-section samples parse anyway — see the verdict-trail note). It lives as a
  `# CROSS-RUN QUALITY SUMMARY (READ-ONLY)` section in `verify.md` — the only
  read-only inspection gate — and derives from the git-tracked `.otto/verdicts.md`
  trail (the cross-run record; the agent `Read`s it, skips if absent) rather than
  the NDJSON logs, appending a `## Cross-Run Quality Summary` block to the
  read-only verify report. Pinned by `quality-report.test.ts`
  ("cross-run quality summary (verify.md)").
- **Human-verdict trail** (Feature 3) lives in the SAME single shared
  `quality-report.md` fragment as the report shape — never a per-mode edit. It
  has two halves, both in that one fragment: a `<verdict-trail>` block surfacing
  `./.otto/verdicts.md` via `!?`cat …|||_No human verdicts recorded yet._`` (so
  prior human verdicts inform this run's Verdict + next action), and a
  **Maintainer:** instruction to append the human verdict (Accepted · Accepted
  with follow-ups · Rejected · **Needs investigation** — note the HUMAN verdict
  uses "Needs investigation", distinct from the report's own "Needs human
  review") + why to the git-tracked trail, feeding the existing learning loop.
  Because it's in the contract fragment it reaches every adopting mode through
  the existing `@include:quality-report.md` — drift-proof, same philosophy as the
  contract + acceptance-prompts. **Its heading is `###`, NOT `##`:** the samples
  doc-contract (`quality-report-samples.test.mjs`) parses the contract's `## `
  lines as THE six report sections via `deepEqual`, so any new `## ` heading in
  `quality-report.md` breaks it — keep non-report subsections at `###`. Pinned by
  `quality-report.test.ts` (surface-when-present / fallback / append-instruction),
  mirroring the apply-review `review-followups.md` trail. The trail file is
  git-tracked (`.otto/`, NOT `.otto-tmp/`) like `LEARNINGS.md`/`review-followups.md`.
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
- **Release-quality gate is a RELEASING.md doc gate, not src.** The "both machine
  verification AND a human-readable quality report before publishing major changes"
  requirement (issue-19 Feature 3) is a `### Release-quality gate` subsection in
  RELEASING.md §2 — no otto code behind it (same agent/docs-driven shape as the
  quality-report contract itself). It names BOTH halves (machine:
  typecheck/tests/smoke; human: a `--verify` Otto quality report) and clears only
  on a human-accepted verdict (Accepted / Accepted with follow-ups), never *Needs
  human review* / *Rejected* — green CI is evidence, not the verdict. It links the
  REAL `packages/core/templates/quality-report.md` contract (drift-proof). Pinned
  by a block in `scripts/releasing-contract.test.mjs` that extracts the section and
  asserts heading + both halves + the contract link exists on disk + the
  gate-clearing verdicts. **Test gotcha:** RELEASING.md line-wraps prose, so a
  verdict phrase like "Needs human review" can split across a newline — normalize
  whitespace (`section.replace(/\s+/g, " ")`) before matching multi-word phrases.
- **A rate-limited panel attempt rolls back BOTH accounting AND evidence
  records.** Panel substages (`recordStage`) write inline as each lens/verify/
  synth completes, but a later substage's limit retries the WHOLE panel
  (`loop.ts` `for(;;)`), so the loop must undo the failed attempt's records too —
  else seq is monotonic and the retry re-records each lens, duplicating records.
  `recordStage` derives seq from `recordedStageFiles.length` (contiguous), the
  retry catch snapshots that length next to the accounting snapshot, and on
  `RateLimitError` `splice`s + `removeStageRecords` the attempt's files so the
  retry reuses the freed seqs. Any future inline-write-during-attempt artifact
  needs the same snapshot/rollback parity. Pinned by `loop.test.ts` "rolls back
  panel sub-stage records when a panel attempt is retried after a rate limit".
- **Safety policy (#43 P4) — `safety-policy.ts` + `taint.ts`; full design in
  `docs/ARCHITECTURE.md` "Safety policy & taint".** **Name gotcha: it's
  `safety-policy.ts`, NOT `policy.ts`** (that's the #41 adaptive-router
  policy); the config is `.otto/policy.json`. `SafetyPolicy` is the six
  issue-scoped `string[]` rule lists; **an empty list = "no restriction" for
  that axis**, so `DEFAULT_POLICY` (all empty, frozen) leaves trusted local
  workflows unchanged (success metric #3) — `parseSafetyPolicy` never throws and
  returns a FRESH object, `readSafetyPolicy` fails OPEN (absent/malformed →
  permissive). The four pure predicates split **deny-list vs allow-list, don't
  conflate them**: `checkCommand`/`checkApprovalRequired` flag a violation per
  MATCH; `checkWritePath`/`checkNetworkDomain` flag when the subject matches NO
  allowed entry (empty = unrestricted). Match boundaries the tests pin: write
  paths are slash-trimmed prefix-at-boundary (`srcfoo` is NOT under `src`);
  domains are exact-or-subdomain (`notgithub.com` is NOT under `github.com`).
  No predicate for `secretPatterns`/`highRiskGlobs` yet (YAGNI). Taint is
  orthogonal (policy = what a run may DO; taint = which INPUTS are untrusted):
  `wrapUntrusted` fences content in `<untrusted source="…">` with
  `UNTRUSTED_WARNING` and **defangs an embedded closing fence** so text can't
  break out. Surfaced as PROSE — the shared `templates/untrusted-content.md`
  fragment (`@include`d once in the 5 untrusted entry blocks) repeats
  `UNTRUSTED_WARNING` VERBATIM on one unbroken line (a `> ` prefix or mid-line
  wrap breaks the `toContain` test); the trusted plan/PRD `{{ INPUTS }}` is
  deliberately NOT wrapped. Pinned by `safety-policy.test.ts` / `taint.test.ts`
  / `untrusted-content.test.ts`.
- **Safety boundary enforcement is the first NON-INERT safety slice (#43 P4
  slice 6).** `stage-exec.ts` reads `.otto/policy.json` once per stage and
  threads it into `render.ts`, which runs `checkCommand` on every `!\`…\`` /
  `!?\`…\`` / `@spill` body BEFORE executing it: a blocked command is **skipped
  (neutralized to its fallback/empty output), never run**, and recorded as a
  `blocked` `policy-violation` `SafetyEvent` on the stage record
  (`StageResult.safetyEvents` → loop's `recordStage`). Under the absent/default
  policy `checkCommand` returns nothing, so the gate is a no-op (metric #3).
  Trajectory plumbing: `SafetyEvent` is a discriminated union on `category`
  (`policy-violation`/`taint`), optional on BOTH `RunManifest` and
  `StageRecord`; `taint` is always `blocked:false`. `eval.ts` sums them into
  an **UNRANKED `safetyEventCount` column — do NOT add a `rank`** (a count
  conflates blocked-violation with detected-injection, no honest direction).
  Pinned by `render.test.ts` / `stage-exec.test.ts` / `run-report.test.ts` /
  `eval.test.ts`.
- **Operator experience (#45 P6) is read-only surfaces over existing substrate;
  design in `docs/ARCHITECTURE.md` "Operator surfaces".** `otto-inspect latest`
  already worked (#39). New: `otto-runs list` (`runs-cli.ts`: `summarizeManifest`
  + `formatRunsList`), `otto-eval compare <a> <b>` (`runEvalCompare` in
  `eval-run.ts` — the NON-paid path; `compare` short-circuits at the TOP of
  `runEval` before any suite/model), and `--explain-routing` (`explainRouting`
  formatter in `risk.ts`, threaded cli-help → run-bin → loop; only meaningful with
  `--adaptive-router`, no-op note otherwise; `--print-config` gains a `routing`
  line). Every bin is the `runInspect` shape (pure formatter + thin `run*(argv,
  deps)`), introduces NO run-time behavior → cannot regress a loop. Pinned by
  `runs-cli.test.ts` / `eval-run.test.ts` / `risk.test.ts` / `cli-help.test.ts`.
- **Skills (#44 P5) — `skills.ts` + `skills-cli.ts`, INERT on the loop (no
  auto-apply this PR); design in `docs/ARCHITECTURE.md` "Skill extraction &
  reuse".** A skill is a DIRECTORY package `.otto/skills/<name>/` (skill.json +
  instructions.md, the .md is the body source of truth), modelled on memory.ts —
  directory-is-the-list, never-throw readers. **Validation gates reuse:**
  `skillStatus` → unvalidated/validated/stale (from `validation.lastValidatedRun`
  + `revalidateAfterDays`, mirrors `memoryStatus`); `selectSkills` treats ONLY
  `validated` as eligible. Retrieval ranks by capability + scope-glob (`globMatch`)
  + risk class (a constraint naming the `classifyRisk` class excludes the skill);
  every `SkillMatch` carries `reasons[]` (the "why selected" metric).
  `findSkillCandidates` groups successful runs by `<bin>::<mode>::<inputs>`,
  suggests ≥2-seen (never auto-promotes). `SkillUsage`/`skillsUsed[]` +
  `skillUsageCount` (unranked eval column) surface usage — INERT until auto-use.
  Read-only `otto-skills` bin (`list`/`audit`/`why`/`candidates`) never runs tests
  or mutates a package. Pinned by `skills.test.ts` / `skills-cli.test.ts`.
- **Context telemetry (#62 P7, slice 1) — `context-report.ts`, pure + INERT on the
  loop.** "Measure before optimizing": `analyzeContext(renderedPrompt)` attributes
  the inline window footprint by category — `commits`/`learnings`/`inputs`/
  `playbook` — so a later P7 slice can prove it shrank the right thing. It segments
  on the **rendered** prompt's stable top-level XML-ish block tags
  (`<commits>`,`<learnings>`,`<inputs>`/`<issue>`/`<issues-summary>`/
  `<issues-full-file>`), and **all four category char counts sum to the whole
  prompt** (recognized blocks → their category, everything else → `playbook` as the
  remainder, never double-counted). Token figures are an ESTIMATE
  (`estimateTokens = ceil(chars/4)`, labelled with `~` in `formatContextReport`) —
  the AUTHORITATIVE per-stage usage stays `tokens.ts`/provider; this answers the
  orthogonal COMPOSITION question a single usage total can't. Segments are sorted
  chars-descending and empty categories are omitted. `file reads` /
  `prior-iteration transcript` are deliberately NOT categories here (agent-runtime/
  cross-iteration, not in one rendered prompt — they belong to the read-dedup /
  compaction slices). Pure like `tokens.ts`/`eval.ts`; wiring into
  `StageResult`/the bundle + an `otto-afk --context-report` surface are later plan
  tasks (`.otto/tasks/issue-62/plan.md`). Pinned by `context-report.test.ts`.
- **Context telemetry capture (#62 P7, slice 2) — `analyzeContext` wired into the
  evidence bundle.** `StageResult.contextBreakdown?` + `StageRecord.contextBreakdown?`
  are OPTIONAL, mirroring `safetyEvents`/`skillsUsed` (absent = not measured, no
  loop-behavior change). `stage-exec.ts` calls `analyzeContext(prompt)` on the
  **post-reduction** `prompt` (the string actually sent to `runStage`, so the
  breakdown reflects the billed footprint, not the pre-reduce render), and merges
  it into the returned result alongside the existing `safetyEvents` spread; the
  loop's `recordStage` threads `sr.contextBreakdown` into the written record.
  **Import direction:** `runner.ts` and `run-report.ts` both `import type
  { ContextBreakdown } from "./context-report.js"` — safe because `context-report.ts`
  imports NOTHING (no cycle). Unlike slice 1 this is no longer fully INERT (every
  recorded stage now carries a breakdown), but it is still loop-neutral — only an
  extra field on the bundle. The `otto-afk --context-report` SURFACE over these
  records is still slice 3. Pinned by `stage-exec.test.ts` (breakdown reflects the
  sent prompt incl. reduce mode) / `run-report.test.ts` (round-trip).
- **Context-report surface (#62 P7, slice 3) — `--context-report` read-only flag +
  `context-report-cli.ts`.** A diagnostic flag (NOT a separate bin) on every AFK bin:
  `parseFlags` → `flags.contextReport`; run-bin early-returns right after resolving
  `workspaceDir` (before any agent/scope/token resolution — it needs none), `await`s
  `runContextReport()` and returns, exactly like `--print-config`. Place the
  early-return BEFORE the positional-arg validation so it needs no `<iterations>`.
  The module mirrors `runs-cli.ts`/`inspect.ts`: pure `formatContextReportRun(runId,
  stages)` + a thin `runContextReport(deps)` that reads ONLY the latest run
  (`listRunIds().at(-1)`, no run-id positional — a flag has none). It reads
  `StageRecord.contextBreakdown` (slice 2) and renders per-stage category shares +
  a first-third-vs-last-third token **slope** (±10% band → growing/flat/shrinking)
  — the "is per-iteration cost bounded?" signal P7's success metric tracks; `n/a`
  until ≥2 measured stages. NOT gated per-bin (mirrors `--print-config`; reading
  `.otto/runs/` works for any bin). It does NOT import a manifest — stage records
  suffice. Pinned by `cli-help.test.ts` (flag parse) + `context-report-cli.test.ts`
  (composition/slope/no-runs). Remaining P7 slices: (4) prefix caching, (5) bounded
  learnings, (6) compaction, (7) read-dedup, (8) per-stage budget.
- **Prompt-prefix caching is REPORT-ONLY in Otto (#62 P7, slice 4) — Otto cannot
  set `cache_control` breakpoints.** Otto spawns the `claude` CLI (`claude --print`),
  it does NOT call the Anthropic API, so it has no lever to "mark a cached prefix":
  there is no `claude` flag for it (see `buildClaudeArgs`), and the rendered prompt
  is delivered as a single `Read` tool-result, not an API content block — reordering
  stable-vs-volatile text inside that file creates NO cacheable sub-prefix. The CLI
  already auto-caches its stable system-prompt/tools, and Otto invokes it with
  identical flags every iteration, so cache hits already occur. The feasible +
  honest half (the issue's explicit success metric, "cache-hit rate reported and
  non-trivial") is to REPORT it: pure `summarizeCacheEfficiency(usages)` →
  `{inputTokens, cacheCreationInputTokens, cacheReadInputTokens, totalInputTokens,
  hitRate}` + `formatCacheEfficiency` in `tokens.ts` (mirrors `formatTokenUsage`).
  `hitRate = cacheRead / (input + cacheCreation + cacheRead)` — **input only, output
  excluded** (generated, never cacheable). Surfaced as one extra line on the EXISTING
  `--context-report` (it already reads the same stage records); drawn from **every**
  stage's authoritative `StageRecord.usage` (NOT just `contextBreakdown`-measured
  ones — cache usage is independent of the estimated composition), and **omitted when
  `totalInputTokens === 0`**. Pinned by `tokens.test.ts` (summarize/format) +
  `context-report-cli.test.ts` (line present w/ usage, omitted w/o).
- **Bounded learnings injection (#62 P7, slice 5) — pure, INERT-on-the-loop
  retrieval+cap in `memory.ts`, NOT a new module.** Three exports layer on the
  existing `projectLearnings`: `selectRelevantMemory(records, ctx)` ranks ACTIVE
  records (derived-stale/superseded excluded, like `projectLearnings`) by
  task-scope relevance — `taskKey` match (+3) > repo-wide/empty-scope (+1) > other
  — ties broken by confidence → useCount → recency (NEWER id first, the reverse of
  `projectLearnings`'s chronological in-section order, because for a budget you
  keep the freshest). `boundLearnings(records, ctx)` greedily takes ranked records
  while cumulative `content.length` stays ≤ budget (`ctx.maxChars ??
  DEFAULT_LEARNINGS_BUDGET_CHARS` = 6000); the FIRST overflow and everything after
  it are `dropped` — a clean rank boundary ("kept the most relevant that fit"), not
  a fill-the-gaps pack. `formatBoundedLearnings` = `projectLearnings(selected)` +
  a one-line `_Bounded: N … omitted …_` note ONLY when something was dropped (no
  drop → byte-identical to the projection). **Deliberately NO changedPaths/scope-glob
  signal** (unlike `selectSkills`): learnings inject at RENDER time, before the
  agent edits anything, so changed files aren't known yet — taskKey is the honest
  injection-time relevance signal (avoids a memory→skills `globMatch` import too).
  Cap is by record `content.length` (deterministic), not rendered-projection size.
  Loop wiring (replacing the templates' `!?cat ./.otto/LEARNINGS.md`) is a later
  slice — this is substrate. Pinned by `memory.test.ts`.
- **Inter-iteration compaction (#62 P7, slice 6) — pure, INERT-on-the-loop
  `iteration-compaction.ts`.** Key realization: Otto spawns a FRESH `claude
  --print` each iteration, so there is NO live transcript carried forward — the
  only prior-iteration state that fills the next prompt's window is the
  `<commits>` block (`git log -n 5 --format="%H%n%ad%n%B---" --date=short`). It is
  count-bounded (5) but each commit BODY is unbounded, so verbose/long histories
  inflate it. So "summarize prior iterations into a bounded state" = bound that
  commit block. `parseCommitLog(raw)` splits on `^---$` lines into
  `{hash,date,subject,body}` entries (first line must be a `[0-9a-f]{7,40}` hash,
  so the `No commits found` fallback → `[]`; never throws). `compactCommits(commits,
  {maxChars})` mirrors slice-5 `boundLearnings` shape but DEGRADES instead of
  DROPS: greedily keep newest-first commits FULL while cumulative
  `renderFull` chars ≤ budget (`DEFAULT_COMMITS_BUDGET_CHARS` = 2400), then the
  first overflow + everything after is summarized to **subject-only** (the commit
  subject IS the iteration's one-line summary — dropping the body, not the commit,
  is the honest "summarize not carry-full" realization that distinguishes it from
  `boundLearnings`'s drop). Reports `savedChars` (body chars removed). `kept` is
  always a contiguous newest prefix + `compacted` the suffix, so
  `[...kept,...compacted]` preserves newest-first order. `formatCompactedCommits`
  re-renders the `<commits>`-style body (full for kept, subject-only for compacted)
  + a one-line `_Compacted: N … saved M chars …_` note ONLY when something was
  compacted. Loop wiring (swapping the template's `!?git log` commit tag for this)
  is a later slice — substrate only. Pinned by `iteration-compaction.test.ts`.
- **Read deduplication (#62 P7, slice 7) — pure, INERT-on-the-loop
  `read-dedup.ts`.** Otto's `@spill` tags re-run a command each iteration and write
  the FULL output to a spill file the agent `Read`s; for file-content spills (issue
  bodies, HEAD patch, big reference files) that content is usually UNCHANGED turn to
  turn yet re-spilled + re-read in full — accumulated context, not work. A
  `ReadLedger` (`{seen: path→ReadFingerprint}`) carried across iterations keys on
  `fingerprintContent(content)` = `"<length>-<FNV-1a-32-base36>"` — a small inline
  hash (module **imports nothing**, no `node:crypto`, no cycle); the length prefix
  means different-length content can never collide and a hash collision only ever
  causes a SAFE re-spill (conservative failure mode). `recordRead(ledger, path,
  content)` is PURE (returns a fresh ledger, never mutates) and classifies the read
  `first` / `unchanged` / `changed`; **`unchanged` reports `savedChars =
  content.length`** (the full re-spill avoided), `first`/`changed` save 0 and must
  spill fresh. Distinct paths track independently; a `changed` read updates the
  ledger so a subsequent identical read dedups. `summarizeReads(results)` tallies
  `{total, first, unchanged, changed, savedChars}` (the run-level "what was
  deduped" surface); `formatReadReference(result, {refPath})` renders the short
  `_Read deduplicated: … (saved N chars) — re-use the copy at <refPath>._` line that
  later replaces the full content. Exported from index.ts. Wiring it into the
  `@spill` path (emit the reference instead of re-spilling when `unchanged`) is a
  later slice — substrate only, cannot regress a run. Pinned by `read-dedup.test.ts`.
  Remaining P7 slice: (8) per-stage context budget.
- **Per-stage context budget (#62 P7, slice 8 — final P7 substrate) — pure,
  INERT-on-the-loop `context-budget.ts`.** The "soft, model-aware ceiling": Otto
  passes the model spec opaquely to the CLI (`resolveModelArgs`, never validated),
  so `modelContextWindow(spec)` LOOSE-matches a lowercased substring → window
  (`[1m]`/`-1m` → 1,000,000 checked FIRST as most-specific, then opus/sonnet/haiku
  → 200,000; conservative `DEFAULT_CONTEXT_WINDOW_TOKENS` = 200,000 on miss/unset).
  `modelContextBudget(spec, fraction)` = `round(window × fraction)` with
  `DEFAULT_CONTEXT_BUDGET_FRACTION` = 0.25 — the budget is for the INLINE rendered
  prompt only, leaving headroom for the agent's tool reads + output.
  `assessContextBudget(breakdown, {model, maxTokens, fraction})` compares the
  slice-1 `ContextBreakdown.estimatedTokens` to the ceiling (`maxTokens` overrides
  the model-derived one) and returns `{estimatedTokens, budgetTokens, windowTokens,
  overBudget, overByTokens, headroomTokens, ratio, recommendation?}`. KEY design:
  the recommendation only appears when over budget AND a **reducible** filler
  exists — it scans the breakdown's chars-descending segments for the first
  category in `{commits, learnings}` and names the lever (commits →
  `compactCommits` slice 6, learnings → `boundLearnings` slice 5). `inputs` (task
  source) and `playbook` (instructions) are NOT P7-reducible, so a prompt that
  overflows on those alone reports over-budget with NO recommendation (honest:
  P7 can't shrink it). `ratio` guards divide-by-zero (0 when budget is 0).
  `formatContextBudget` renders a one-line `within budget` / `EXCEEDS by N
  tokens — compact <category> via <lever>` warning (`~` marks the estimate; the
  budget is exact). Soft, never a gate. Loop wiring (warn + actually trigger the
  slice-5/6 levers on overflow) is a later slice — substrate only. Exported from
  index.ts. Pinned by `context-budget.test.ts`. All six issue-#62 scope items now
  have pure substrate; the remaining P7 work is loop-wiring slices 4–8 to turn the
  substrate into measured savings.
- **Plan-quality rubric (#63 P8, slice 1) — pure, INERT-on-the-loop
  `plan-rubric.ts`.** P8 (spec & plan authoring) is burned down RUBRIC-FIRST, the
  same "measure before optimizing" discipline as P7: you can't prove a `plan`
  stage emits world-class plans, nor track the success metric "plan-completeness
  rubric score ↑", without first a way to SCORE a plan. The rubric is a sibling to
  `eval.ts`'s `scoreTrajectory` (pure scorer over recorded data) but scores a plan/
  spec markdown DOCUMENT, not a run trajectory. `scorePlanQuality(doc)` checks 8
  criteria — problem, decisions/assumptions, scopeGuard, fileMap, taskBreakdown,
  testFirst, verifyCommands, successCriteria (the issue's explicit four + the
  proven-shape essentials) — each a PURE deterministic predicate (header/keyword
  heuristics in `PLAN_CRITERIA`, no tokenizer, no model). It judges STRUCTURAL
  completeness (does the plan have the sections a good plan has), the orthogonal
  question to the SEMANTIC quality a human/model judges at the checkpoint —
  heuristic and labelled as such (mirrors P7's ceil(chars/4) honesty). Returns
  `{results[], metCount, maxScore, ratio (0..1, 0 when no criteria), missing[]}`;
  equal weights (YAGNI on weighting — the per-criterion breakdown lets a consumer
  reweight later). `formatPlanRubric` renders a `plan quality: N/8 (P%)` scorecard
  with a `[x]/[ ]` line per criterion + a `missing:` note. Detector edge: fileMap
  matches a "File map/structure"/"Files"/"component map" HEADING OR ≥2 path-like
  backticked tokens (`/`-or-source-extension, so `pnpm -r test` is NOT counted as
  a path); verifyCommands needs `verify:` OR (a verify mention AND a command
  token). Exported from index.ts. Wiring (capture as eval signal, `--plan-report`
  surface, the `plan` stage + template, the human checkpoint) are later slices —
  substrate only, cannot regress a run. Pinned by `plan-rubric.test.ts`. Plan:
  `.otto/tasks/issue-63/{spec,plan}.md` (7 slices, this run = slice 1).
- **Plan quality as an eval signal (#63 P8, slice 2) — `eval.ts`.** `EvalSignals`
  gains `planQualityRatio: number | null` (the slice-1 rubric `ratio`, `null` when
  no plan was scored). KEY purity move: `scoreTrajectory` stays pure (no I/O) by
  taking the ALREADY-COMPUTED score via an optional 3rd arg `{ planScore?:
  PlanRubricScore }` — the rubric reads a DOCUMENT, the trajectory scorer reads the
  manifest/stages, so the document read happens at the call site (a later wiring
  slice), never in eval.ts. `compareTrajectories` gains a higher-is-better "Plan
  quality" column rendering `${round(ratio*100)}%` or `—` for null (excluded from
  ranking, like `elapsedMs` null). Existing `scoreTrajectory` callers (`eval-run.ts`)
  pass no `planScore` → `null`, so the A/B table is unaffected until plans are
  scored. Pinned by `eval.test.ts`. Adding a field to `EvalSignals` requires the
  test `signals()` helper default to include it (`planQualityRatio: null`).
- **`otto-afk --plan-report` (#63 P8, slice 3) — `plan-report-cli.ts`.** Read-only
  surface mirroring `--context-report`: pure/I-O split — `formatPlanReport(tasks)`
  is PURE (renders a per-task scorecard via `formatPlanRubric`), `readTaskPlans(ws)`
  does the I/O (scans `<ws>/.otto/tasks/`, for each subdir scores `spec.md` +
  `plan.md` CONCATENATED — the rubric criteria span both files — skipping empty
  dirs, `[]` on missing dir, never throws), `runPlanReport(deps)` glues them and
  returns an exit code (1 when no plan). Flag wiring is the SAME 5-touch pattern as
  every other early-exit flag: `CliFlags.planReport` field + `let planReport=false`
  + `--plan-report` arm + include in the returned object + a help line in
  `cli-help.ts`; then a `run-bin.ts` early-return (dynamic `import()` of
  `plan-report-cli.js`, `if (code !== 0) process.exit(code)`, before workspace/arg
  resolution). Exported from index.ts. Pinned by `plan-report-cli.test.ts` +
  `cli-help.test.ts` (`parseFlags`) + `run-bin.test.ts` (exit-code propagation).


## Gotchas

- **This dev host cannot execute the Codex CLI — live `codex exec --json`
  verification is impossible here (issue #24 P3).** Two independent failures: (1)
  the installed `@openai/codex` 0.104.0 npm shim is on PATH but its vendored
  native binary is missing (`vendor/.../codex` ENOENT, empty dir); (2) a
  freshly-downloaded official release binary
  (`gh release download rust-v0.104.0 --repo openai/codex --pattern
  codex-aarch64-apple-darwin.tar.gz`) — `codesign --verify` reports "valid on
  disk / satisfies its Designated Requirement" — is still **SIGKILL'd (rc 137)**
  on every invocation, even with the command sandbox disabled and after `xattr
  -c`. So it is NOT a Gatekeeper/signature issue; the environment itself kills
  it. Consequence: the P3 codex *adapter* (whose `parseResultEvent` needs the
  UNVERIFIED `exec --json` event schema) cannot be verified here — only the
  schema-independent pieces (preflight, and later the argv builder) are
  shippable on this host. Re-attempt the adapter where `codex exec --json` runs.
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
