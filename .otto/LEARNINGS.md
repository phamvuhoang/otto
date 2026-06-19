# Otto learnings

## Conventions

- **Run evidence bundle lives under `.otto/runs/<run-id>/` (issue #39 P0).** Pure
  module `run-report.ts` mirrors `state.ts` (fs + JSON, absent/malformed → safe
  null/`[]`, injectable `Date`/`pid`): `RunManifest` (manifest.json: bin/mode/
  inputs/runtime/branchStrategy/iterations/cost/tokens/exitReason/nextAction/
  artifacts/timestamps) + per-stage `StageRecord`s under `stages/`. **Key shape
  decision: the `stages/` DIRECTORY is the stage list — the manifest does NOT
  duplicate it** (`readStageRecords` discovers by sorted filename), so there's no
  two-source sync. `allocateRunId(date?,pid?)` = ISO timestamp (`:`/`.`→`-`) +
  `-<pid>` → lexicographically sortable (so "latest" is a plain string sort) and
  collision-safe per host. Stage filenames are `<seq4>-iter<n>-<stage>.json` with
  the stage segment sanitized to `[A-Za-z0-9_-]` (panel lens names from
  `OTTO_REVIEW_LENSES` are free text → a filename). The module is **INERT** until
  loop wiring (plan task 2+ in `.otto/tasks/issue-39/plan.md`): nothing imports it
  from the loop yet, so it can't regress behavior — same "ship the substrate first,
  inert" pattern as `task-key.ts`. Bundles go in `.otto/` (durable like
  `state.json`), NOT `.otto-tmp/`; raw `.otto-tmp/logs` is untouched. Pinned by
  `run-report.test.ts`.
- **Agent-runtime docs span 5 surfaces, pinned by one doc-contract test, and
  document Codex HONESTLY (issue #24 P5).** The runtime feature is documented in
  README (flags/env lists + a `--print-config` example), `docs/CLI.md` (a
  `## Agent runtime (--agent)` section — anchor `#agent-runtime---agent`, also in
  the TOC), `docs/CONFIG.md` (env-var rows + a runtime-aware preflight note),
  `SECURITY.md` (per-runtime credential/sandbox: claude `~/.claude`+`--settings`;
  codex `~/.codex/auth.json`/`OPENAI_API_KEY`+its own `--sandbox`), and
  `docs/ARCHITECTURE.md` (a `### Agent runtime abstraction` subsection). All five
  are drift-proofed by `scripts/agent-runtime-doc-contract.test.mjs`, which
  **parses `AGENT_DISPLAY_NAMES`/`DEFAULT_AGENT` + the flag names from source**
  (not hardcoded) so adding a runtime id forces the docs to grow — same pattern as
  `security-doc-contract`/`quality-report-samples`/`migration-doc-contract`. **The
  framing decision to preserve:** Codex is documented as *selectable* (flag/env/
  config), *preflighted*, *model-env-aware*, and *fallback-configurable*, but its
  **execution adapter is explicitly "not yet shipped"** (a real `--agent codex`
  run exits "not implemented yet") — do NOT let a future doc edit claim Codex
  *runs* until the BLOCKED adapter lands. The test's "no doc claims Otto runs only
  Claude" case guards the opposite drift. **The four P5 smoke scenarios needed no
  new harness — they were already unit-tested** (`cli-help.test.ts`/`loop.test.ts`
  for default config/banner + runtime visibility, `preflight.test.ts` for
  codex-preflight-fails-clean, `loop.test.ts` for the auto-switch mocked-limit
  path); the doc-contract test is the only net-new test (YAGNI on redundant smoke).
- **Switch-on-limit is loop-orchestration, not a runner change (issue #24 P4).**
  `runLoop` gained `fallbackAgentId`/`fallbackAgentDisplayName`/`autoSwitchOnLimit`
  (from run-bin's resolved `fallback.*`, threaded through `runWatch` too). The
  active runtime is a **mutable** `activeAgentId`/`activeAgentDisplayName` (starts
  at the primary `agentId`); EVERY downstream seam that used `agentId`/
  `agentDisplayName` now reads the `active*` vars (stage banner, executeStage +
  panel `agentId`, failure `stageLogPath`, summary) so they track the live runtime
  after a switch. The switch happens **inside the existing rate-limit catch** in
  `loop.ts`, AFTER the accounting rollback to `accountingSnapshot` (so budget/token
  totals survive) and BEFORE the wait/halt path: `if (autoSwitchOnLimit &&
  fallbackAgentId && activeAgentId !== fallbackAgentId)` → reassign `activeAgentId`
  to the fallback, set `switched=true`, print `↪ auto-switch on rate limit: <from>
  → <to> for iteration N <stage>`, `persist(i,"running")`, `continue` the `for(;;)`
  retry loop (runOnce closes over the mutable `activeAgentId`, so the retry runs on
  the fallback). **Only ONE switch** — once `activeAgentId === fallbackAgentId` the
  guard is false, so a fallback that ALSO limits falls through to the normal
  wait/halt (no ping-pong, matches the "switched once" summary). `RunState.agent`
  (new optional field, `state.ts`) persists the active runtime each `persist()`;
  on resume, `if (resuming && prior.agent && prior.agent !== agentId)` restores it
  (`switched=true`, display from `AGENT_DISPLAY_NAMES`) so a resumed run keeps the
  fallback — `--fresh` clears state → back to primary. Summary shows `runtime:
  <primary> -> <active> (switched once: rate limit)` when switched, else `<active>`.
  Pinned by `loop.test.ts` "auto-switch on limit" (claude→codex, codex→claude,
  off→wait, fallback-also-limits→wait, resume-keeps-fallback); the test reads the
  retry's runtime via `runStage.mock.calls[n][6].runtime.id` (the mocked
  `getAgentRuntime` returns `{id}`). **End-to-end cross-provider switching is still
  gated on the BLOCKED Codex adapter** — a real switch to codex hits
  `getAgentRuntime`'s "not implemented" throw; the orchestration is provider-neutral
  and fully unit-tested with mocks, and becomes runnable when the codex adapter lands.
- **Fallback-on-limit config is parsed + reported but inert (issue #24 P4,
  config slice).** `agent-runtime.ts` adds `resolveFallback({flagAgent, envAgent,
  configAgent, flagAutoSwitch, envAutoSwitch, configAutoSwitch})` →
  `{agent?: ResolvedAgentRuntime, autoSwitch}` and `readFallbackConfig(workspaceDir)`
  → `{agent?, autoSwitch?}` (reads `.otto/config.json` `fallbackAgent` string +
  `autoSwitchOnLimit` boolean; wrong-typed dropped). **Two deliberate asymmetries
  vs. `resolveAgentRuntime`:** (1) the fallback agent has **NO default** — unset =
  no fallback (returns `{autoSwitch}` with no `agent`), because switching
  providers must be explicit; (2) auto-switch is a boolean with precedence
  flag(true)→env-truthy→config→false, where env-truthy = `1|true|yes|on`
  (case-insensitive, via `isTruthyEnv`) and an explicit falsy env (`0`/`false`)
  WINS over a `true` config (blank env falls through). The fallback agent reuses
  `parseAgentId` so an invalid `OTTO_FALLBACK_AGENT`/config `fallbackAgent` throws
  (named for `--print-config` reporting). Wiring **mirrors the `agent` block in
  run-bin exactly**: resolved into `fallback`/`fallbackError`, reported by
  `--print-config` (exit 0), **fatal (exit 1) on a real run** right after the
  agentError guard. `--print-config` shows one `fallback` line:
  `<id> (<name>, <source>) · auto-switch on|off` when an agent is set, else
  `auto-switch on · no fallback agent set` (misconfig warning) when only switch is
  on, else `off`, else `invalid (<err>)`. This slice resolved config only; the
  actual switch-on-limit at the retry/stage boundary now lives in `loop.ts` (see
  the switch-on-limit bullet above). Default-off keeps Claude behavior unchanged.
  Pinned by `agent-runtime.test.ts`
  (resolveFallback precedence/truthy/no-default/throw + readFallbackConfig),
  `cli-help.test.ts` (`--fallback-agent`/`--auto-switch-on-limit` parse +
  print-config fallback line incl. the no-agent warning), `run-bin.test.ts`
  (env selection + invalid-reported + invalid-fatal).
- **Provider-specific model env is runtime-aware via `resolveModelSelection`
  (issue #24 P3).** `runner.ts`'s `resolveModelSelection(runtimeId, env)` picks
  `OTTO_<RUNTIME>_MODEL` (e.g. `OTTO_CLAUDE_MODEL` / `OTTO_CODEX_MODEL`) over the
  provider-neutral `OTTO_MODEL`; an empty/whitespace override falls THROUGH to
  the generic value (so an unset-but-present var doesn't suppress `OTTO_MODEL`).
  It returns `{spec, source}` — `source` is the literal env var name, used by
  `--print-config`'s model line (`<value> (<source>)`, else
  `<runtime> CLI default (OTTO_<RUNTIME>_MODEL / OTTO_MODEL unset)`). `runStage`
  feeds `resolveModelSelection(runtime.id)?.spec` into the EXISTING
  `resolveModelArgs` (kept as the single `--model` arg builder; not duplicated),
  so the per-runtime override reaches the spawned CLI — `runStage`'s old
  `resolveModelArgs(process.env.OTTO_MODEL)` call is the only wiring that
  changed. `cli-help.ts` imports `resolveModelSelection` from `runner.js` (no
  cycle: runner doesn't import cli-help). Pinned by `runner.test.ts`
  (precedence/leak/empty/trim) + `cli-help.test.ts` (print-config model line).
  Comprehensive README/CLI.md/CONFIG.md docs deferred to P5 (help text +
  print-config touched here, mirroring the scope-flag commits).
- **Runtime-aware preflight: `runPreflight(opts.agentId)` shows the SELECTED
  runtime's CLI/auth rows, not both (issue #24 P3).** `runPreflight` takes an
  optional `agentId`; default/`claude` → `claude CLI`+`claude auth` rows
  (unchanged), `codex` → `codex CLI`+`codex auth` rows INSTEAD (Claude-specific
  checks are not shown blindly for a codex run). The git/gh/linear rows are
  per-bin and runtime-independent. Threaded from `printConfig`'s `agentId` into
  the `runPreflight` call. **The codex CLI row probes runnability, not PATH
  presence:** it requires `codex --version` to exit 0 via a new injectable
  `probeVersion` probe (default `probeVersionBin` = `spawnSync(name,["--version"])
  .status===0`, never throws) — because the `@openai/codex` npm shim sits on PATH
  while its vendored native binary can be missing/broken, so `which codex`
  succeeds but the binary is unusable (spike gap #5). New `PreflightProbes`
  fields: `probeVersion(name)` and `env` (for `OPENAI_API_KEY`); the
  `allPresentProbes` test helper must supply both. Codex auth = `~/.codex/auth.json`
  OR `OPENAI_API_KEY`. Pinned by `preflight.test.ts` (injected probes: usable /
  shim-broken / missing / auth-file / api-key / none) + `cli-help.test.ts`
  (host-independent: match preflight rows by the `[✓✗] <label>` glyph prefix, NOT
  bare `claude CLI` — the model line `"claude CLI default (OTTO_MODEL unset)"`
  also contains that substring). The full codex `AgentRuntime` adapter
  (`parseResultEvent`) stays BLOCKED until the `exec --json` schema is verified on
  a host that can run codex — see the gotcha below.
- **Codex spike lives in `scripts/`, not `src/` (issue #24 P2).** The Codex CLI
  adapter spike is a *throwaway harness* + findings doc, NOT production code:
  `scripts/codex-spike.mjs` (candidate `parseCodexEvents`/`detectCodexRateLimit`/
  `codexPreflight`/`buildCodexArgs` + a runnable smoke) pinned by
  `scripts/codex-spike.test.mjs` (auto-globbed by `pnpm test`), findings in
  `docs/spikes/codex-runtime-spike.md`. Deliberately OUTSIDE `packages/core/src/`
  so (a) the unverified Codex parsing doesn't pollute the runner hot path (honours
  the P0 "stays generic until the spike reveals the shape" call) and (b) it ships
  in no tarball (`scripts/` isn't in core's package `files`). **P3 promotes** the
  verified pieces into a real `codexRuntime` `AgentRuntime` adapter + preflight
  rows. Key spike findings the P3 adapter must act on: Codex is driven by
  `codex exec --json` (JSONL thread/item events — **schema UNVERIFIED**, the live
  smoke was BLOCKED because Codex 0.104.0's vendored native binary is missing here,
  ENOENT/empty `vendor/`); Codex emits **no USD cost** (only token counts → budget
  reports $0 until cost is derived); it has **no `--settings` sandbox** (uses its
  own `--sandbox <mode> --ask-for-approval never`, so codex's adapter sets
  `supportsSandboxSettings:false`); auth is `~/.codex/auth.json` OR `OPENAI_API_KEY`;
  and preflight must check `codex --version` succeeds, not just PATH presence (the
  npm shim is on PATH even when its native binary is broken).
- **`AgentRuntime` adapter boundary (issue #24 P0 step 3)** — the runner no
  longer hardcodes `claude`; everything Claude-specific lives behind an
  `AgentRuntime` object in `runner.ts`: `{ id, displayName, command,
  supportsSandboxSettings, buildArgs(stage,promptRel,modelArgs,settings?),
  parseResultEvent(ev) }`. `claudeRuntime` is the sole adapter (delegates
  `buildArgs`→`buildClaudeArgs`, `parseResultEvent`→`resultFromEvent(ev,"claude")`);
  `getAgentRuntime(id)` selects it from a `Partial<Record<AgentRuntimeId,…>>`
  registry and **throws a clean "not implemented" for `codex`** (defensive
  backstop — real codex runs are already blocked upstream in run-bin, so this is
  belt-and-suspenders, NOT the primary guard). `streamClaude`→`streamRuntime`
  gained a `runtime` param and routes the final result through
  `runtime.parseResultEvent`, stamping the new **`StageResult.runtimeId`** (the
  contract's "StageResult identifies the runtime that produced it"); all
  `claude`-literal log/error strings now use `runtime.command` so claude output
  is byte-for-byte identical. `runStage` takes the adapter via a new optional
  `RunStageOptions.runtime` (defaults `claudeRuntime`, so old callers/test mocks
  are unchanged); `stage-exec` selects it with `getAgentRuntime(opts.agentId ??
  DEFAULT_AGENT)`. **Test gotcha:** any test that `vi.mock("../runner.js")` must
  now also stub `getAgentRuntime` (loop.test.ts + stage-exec.test.ts both mock
  the module) or `executeStage` throws on the undefined import; a `(id)=>({id})`
  stub suffices since the mocked `runStage` ignores it. **Scope call:** rate-limit
  detection (`isLimitResult`/`resetsAtFromEvent` in `rate-limit.ts`) was NOT moved
  behind the adapter — it stays generic until the P2 Codex spike reveals Codex's
  signal shape (YAGNI; the plan bullet listed it but P0 acceptance doesn't).
  `supportsSandboxSettings` gates writing the `--settings` file (claude=true →
  unchanged). Pinned by `runner.test.ts` (`getAgentRuntime` selection + throw,
  `claudeRuntime` adapter output, `resultFromEvent` runtimeId stamp). The next
  P0/P2 task is the throwaway Codex spike.
- **Runtime visibility threading (issue #24 P1 step 2)** — the resolved
  `{id,displayName}` reaches `runLoop` via two new `LoopOptions`
  (`agentId`/`agentDisplayName`, default `claude`/`Claude Code`) wired from
  run-bin's `agent.id`/`agent.displayName`, surfacing on FOUR seams: the version
  banner (`… (core x) · runtime: <displayName>`), the per-stage banner
  (`… (stage n/m) · <displayName>`, both color + plain), the NDJSON log filename
  (`stageLogPath` gained an optional 4th `runtimeId` arg → `-<id>` suffix; passed
  by `stage-exec.ts` via a new `ExecuteStageOptions.agentId` and by loop's
  failure-marker call), and the summary line (`· runtime: <id>`). The panel
  threads it too (`RunPanelOptions.agentId` → each `executeStage`), so lens/synth
  logs are runtime-labelled. `runWatch` carries `agentId`/`agentDisplayName`
  through to its inner `runLoop`. **The log suffix is ALWAYS applied on a real
  run** (claude → `-claude.ndjson`); the "Claude behavior byte-for-byte" rule is
  about the spawned CLI args/output, not internal artifact filenames, and the
  roadmap explicitly wants the runtime in the log path. `stageLogPath`'s param is
  optional so test mocks/older callers stay back-compatible (no suffix when
  omitted). Pinned by `runner.test.ts` (suffix present/absent), `loop.test.ts`
  (banner+summary show runtime; claude default), `stage-exec.test.ts` (agentId →
  filename). The runner still spawns `claude` — adapter extraction is the next
  plan task (P0 boundary).
- **Agent runtime selection (`--agent`/`OTTO_AGENT`/config `agent`, issue #24
  P0/P1 step 1)** is config-parsing + visibility ONLY — the runner still spawns
  `claude` (no adapter yet). Pure module `agent-runtime.ts`: `AgentRuntimeId =
  "claude"|"codex"`, `DEFAULT_AGENT="claude"`, `AGENT_DISPLAY_NAMES`,
  `parseAgentId(raw,source)` (throws clean `… must be one of claude|codex`),
  `resolveAgentRuntime({flag,env,config})` → `{id,displayName,source}` with
  precedence **flag → env → config → default** (blank env/config skipped, not an
  error), and `readAgentConfig(workspaceDir)` reading the `.otto/config.json`
  `agent` string (never throws; kept separate from `readBranchConfig` to
  decouple). Wiring **mirrors the OTTO_TOKEN_MODE pattern exactly**: the
  `--agent` flag is validated in `parseFlags` (throws → clean); an invalid
  `OTTO_AGENT`/config value is caught in run-bin into `agentError`, **reported by
  `--print-config` without a stack trace (exit 0) but fatal (exit 1) on a real
  run**. `--print-config` shows `runtime <id> (<displayName>)` + `runtime source
  <source>`. Crux: a real run whose resolved `id !== "claude"` **exits 1 with a
  "not implemented yet" message** rather than silently running Claude — this
  preserves the issue's "user always knows the active runtime" contract before
  the Codex adapter exists; `--print-config` still reports the codex selection
  (read-only diagnostic, no guard). Default stays Claude → behavior unchanged.
  Pinned by `agent-runtime.test.ts` (parse/resolve/read), `cli-help.test.ts`
  (`parseFlags --agent` + print-config runtime lines), `run-bin.test.ts`
  (env-selection + invalid-reported + not-implemented-fatal; the fatal test
  spies on `console.error` and mocks `process.exit` to throw — `process.stderr.write`
  spy does NOT capture `console.error`). Spec/plan: `.otto/tasks/issue-24/`.

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
