# Architecture

Internals reference for **library extenders** of `@phamvuhoang/otto-core` and **core contributors** who need the runtime model before touching `loop` / `render` / `runner`. For user-facing install/setup, see [`../README.md`](../README.md); for release mechanics, [`../RELEASING.md`](../RELEASING.md).

All source links are relative to this `docs/` directory (e.g. [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts)).

---

## Overview

Otto ships as a pnpm monorepo (Node >= 20, pnpm >= 9, root `packageManager pnpm@9.12.0`) that produces three release components:

| Component                | Path            | Version | What it is                                                                                                                        |
| ------------------------ | --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@phamvuhoang/otto-core` | `packages/core` | 0.6.3   | Library: loop driver, native-sandbox runner, template renderer, stage registry, AFK machinery. ESM, TS → `dist/`.                 |
| `@phamvuhoang/otto`      | `apps/cli`      | 0.6.3   | CLI exposing `otto-afk` and `otto-ghafk` bin entries. Hand-written JS bins, **no build step**, depends on core via `workspace:^`. |

Both packages are **ESM only** (`"type": "module"`). Relative imports inside [`../packages/core/src`](../packages/core/src) end in `.js` (compiled-output extension required by `moduleResolution: NodeNext`).

The harness drives the Claude Code CLI against a target repository in an iterating **implementer → reviewer** loop. Otto runs `claude` directly on the host; the default `OTTO_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine writes to the workspace. Nothing persists between stages except the git history written into that workspace.

---

## End-to-end data flow

```
otto-afk / otto-ghafk           bin (apps/cli/bin/*.js → import { runAfk|runGhAfk })
        │
        ▼
runAfk / runGhAfk                 (main.ts / gh-main.ts → runBin in run-bin.ts)
   parseFlags (cli-help.ts)       --help/-V/--print-config/--no-keep-alive/--max-retries/--detach/--log/--notify/--token-mode
   resolve workspaceDir, packageDir from env
   [--detach] detachAndExit       fork-and-exit, parent returns 0
        │
        ▼
runLoop (loop.ts)
   acquire() wake-lock (keepalive.ts)         once, unless --no-keep-alive
   install SIGINT/SIGTERM handlers + AbortController
   for i in 1..iterations:
     for s in 0..stages.length-1:
        executeStage(...)  (stage-exec.ts)     renderTemplate + optional prompt reduction
        runStage(...)  (runner.ts)             wrapped in withRetries (retry.ts)
           writeFileSync(.run-*.md)
           [sandbox] writeFileSync(.sandbox-*.json) native OS sandbox settings
           spawn claude … (cwd = workspaceDir)
           streamClaude: NDJSON → live print (stdout text / stderr tools)
                                  capture "result" event → return value
        if s == 0 and result ⊇ SENTINEL: print "Otto complete", return
   finally: release wake-lock, off() signal handlers, [--notify] toast
```

The bin layer is thin: it parses flags, resolves two directories, and calls `runLoop` with a stage chain plus an `inputs` string. `runLoop` owns the iteration, signal handling, wake-lock, retries, and the sentinel gate. `renderTemplate` is a pure-ish synchronous string transform that may shell out to the **host** to expand tags. `runStage` spawns `claude` on the host; `streamClaude` parses the NDJSON, prints assistant text to stdout and tool/diagnostic events to stderr, and returns the `result` event's payload as the stage value.

Two resolved directories drive everything (set in `run-bin.ts`, shared by both bins):

| Dir            | Source                                    | Use                                                             |
| -------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `workspaceDir` | `OTTO_WORKSPACE` or `process.cwd()`       | Host repo Claude runs against (`cwd`); root for `.otto-tmp/`.   |
| `packageDir`   | `resolve(dirname(import.meta.url), "..")` | The installed core package dir; `templates/` is read from here. |

---

## Loop topology

Chains are first-stage-gated. The base two:

```
otto-afk   → [STAGES.implementer,      STAGES.reviewer]   inputs = "<plan-and-prd>"
otto-ghafk → [STAGES.ghafkImplementer, STAGES.reviewer]   inputs = ""
```

`run-bin.ts` swaps the **gate** stage (index 0) for alternate `otto-afk`/`otto-ghafk` modes; the rest of the chain and the whole loop (resilience, `state.json` `mode`, reconcile-against-git) are unchanged:

```
otto-ghafk --issue N      → [STAGES.ghafkIssueImplementer, STAGES.reviewer]   inputs = "N"
otto-afk --verify         → [STAGES.verifier]                                 inputs = "<plan-and-prd>" (one pass, read-only)
otto-afk --apply-review D  → [STAGES.applyReviewImplementer, STAGES.reviewer]  inputs = D (review-doc path)
```

- **`otto-afk` is plan/PRD-driven.** Its first positional arg is forwarded verbatim as the `{{ INPUTS }}` tag.
- **`otto-ghafk` is GitHub-issue-driven.** No input arg; `inputs = ""` and the issue context is pulled by the template via `gh`.
- **`--verify`** is one-shot (`iterations` forced to 1, no reviewer) and writes a read-only report to `.otto-tmp/verify-report.md` — it makes no commits. **`--apply-review`** triages an external review document, fixing one actionable finding per iteration and accumulating deferred ones in the git-tracked, task-local `.otto/tasks/<task-key>/followups.md` (legacy `.otto/review-followups.md` read as fallback for one release — see [MIGRATION.md](./MIGRATION.md)).

**The first stage of a chain is always the gate.** After its stage runs, `loop.ts` checks the captured `result` for the exact literal sentinel:

```
<promise>NO MORE TASKS</promise>
```

On a hit the loop prints `Otto complete` and returns immediately — subsequent stages do **not** run. The sentinel string is hardcoded as `SENTINEL` in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts), and the agent is told to emit it (see [`../packages/core/templates/prompt.md`](../packages/core/templates/prompt.md)) when no AFK tasks remain. The **reviewer never gates** — only `s === 0` is sentinel-checked.

**Failure handling within an iteration:** each stage is wrapped in `withRetries`. If a stage exhausts its retry budget, `loop.ts` writes a `[failure]` marker to the stage log, prints a failure line, and `break`s out of the stage loop — abandoning the rest of _that_ iteration. The outer iteration loop then proceeds to the next iteration (`i + 1`). A stage failure does **not** abort the whole run.

---

## Module map

[`../packages/core/src`](../packages/core/src) holds the following key TypeScript modules plus `__tests__/`.

| Module                                                            | Responsibility                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](../packages/core/src/main.ts)                         | `runAfk` bin entry: parse flags, resolve dirs, optionally detach, then `runLoop([implementer, reviewer], inputs=planAndPrd)`.                                                                                                                             |
| [`gh-main.ts`](../packages/core/src/gh-main.ts)                   | `runGhAfk` bin entry: same shape, `runLoop([ghafkImplementer, reviewer], inputs="")`.                                                                                                                                                                     |
| [`loop.ts`](../packages/core/src/loop.ts)                         | `runLoop` — iteration driver: wake-lock, signal handlers, per-stage render→runStage with retries, sentinel gate, rate-limit wait (capped by `--max-wait`), resume from saved state, notify on terminal events.                                            |
| [`render.ts`](../packages/core/src/render.ts)                     | `renderTemplate` — expand the five tag forms; `resolveShell` picks the host shell for shell/spill tags.                                                                                                                                                   |
| [`stage-exec.ts`](../packages/core/src/stage-exec.ts)             | Shared render/retry/run helper used by the loop and review panel. Applies `--token-mode reduce` prompt compaction after template rendering and before `runStage`.                                                                                         |
| [`tokens.ts`](../packages/core/src/tokens.ts)                     | Pure token usage parsing/formatting, token-mode validation, and aggregation helpers.                                                                                                                                                                      |
| [`prompt-reduction.ts`](../packages/core/src/prompt-reduction.ts) | Conservative render-time prompt compaction for reduce mode. It does not remove context or cache mutating agent outputs.                                                                                                                                   |
| [`runner.ts`](../packages/core/src/runner.ts)                     | Native-sandbox runner: `runStage`, `streamClaude`, sandbox-settings helpers, `stageLogPath`, TTY-gated color exports. Reads `OTTO_RUNNER` / `OTTO_SANDBOX_NET`.                                                                                           |
| [`stages.ts`](../packages/core/src/stages.ts)                     | `STAGES` registry: `implementer` (afk.md), `ghafkImplementer` (ghafk.md), `reviewer` (review.md), all `bypassPermissions`; `Stage` type.                                                                                                                  |
| [`index.ts`](../packages/core/src/index.ts)                       | Public barrel for the library surface.                                                                                                                                                                                                                    |
| [`cli-help.ts`](../packages/core/src/cli-help.ts)                 | `parseFlags`, `printHelp`, `printVersion`, `printConfig`, `readCoreVersion`. **Internal** (not exported from `index.ts`).                                                                                                                                 |
| [`retry.ts`](../packages/core/src/retry.ts)                       | `withRetries`, `backoffFor`, `DEFAULT_BACKOFF_MS`, `DEFAULT_MAX_RETRIES`. **Internal.**                                                                                                                                                                   |
| [`keepalive.ts`](../packages/core/src/keepalive.ts)               | `acquire` — OS wake-lock, returns a `Releaser`; per-platform inhibitor. **Internal.**                                                                                                                                                                     |
| [`detach.ts`](../packages/core/src/detach.ts)                     | `detachAndExit`, `stripDetachFlags` — fork loop into background, parent exits 0. **Internal.**                                                                                                                                                            |
| [`notify.ts`](../packages/core/src/notify.ts)                     | `notify`, `notifyComplete`, `notifyError` — OS toast + terminal bell. **Internal.**                                                                                                                                                                       |
| [`branch.ts`](../packages/core/src/branch.ts)                     | `resolveBranchStrategy` — resolves the branch strategy once at startup (precedence: flag/env → `.otto/config.json` → TTY prompt → `current`) and returns the effective workspace dir the loop runs in (a worktree path in `worktree` mode). **Internal.** |
| [`git.ts`](../packages/core/src/git.ts)                           | Shared low-level git helpers (branch creation, worktree setup, dirty-tree detection). Used by `branch.ts` and `panel.ts`. **Internal.**                                                                                                                   |
| [`rate-limit.ts`](../packages/core/src/rate-limit.ts)             | Detects Claude rate-limit events from the NDJSON stream; extracts the reset timestamp and throws a `RateLimitError` carrying `resetsAt`. **Internal.**                                                                                                    |
| [`state.ts`](../packages/core/src/state.ts)                       | Reads and writes advisory `.otto/state.json` (gitignored) — bin, mode, inputs, iteration/total, status, `resetsAt`; `matchesResume` determines whether a saved state matches the current invocation. **Internal.**                                        |
| [`run-report.ts`](../packages/core/src/run-report.ts)            | The run evidence bundle: `RunManifest` / `StageRecord` / `RunArtifact` types, `allocateRunId`, path helpers (`runsDir` / `runReportDir`), and `.otto/runs/<run-id>/` I/O (`writeManifest` / `readManifest` / `writeStageRecord` / `readStageRecords` / `removeStageRecords` / `listRunIds`). Pure fs + JSON, mirrors `state.ts` (absent/malformed → safe null/`[]`).                                |
| [`inspect.ts`](../packages/core/src/inspect.ts)                   | `otto-inspect` command: pure `formatRunReport(manifest, stages)` → report string, plus `runInspect(argv, deps)` resolving a run id (`latest`/no arg → newest) and printing it. Read-only.                                                                  |
| [`memory.ts`](../packages/core/src/memory.ts)                     | Governed memory substrate: `MemoryRecord` (provenance / `scope[]` / `confidence` / `trust` / `status` / freshness fields) + `.otto/memory/<id>.json` I/O (`allocateMemoryId`, `memoryDir` / `memoryRecordPath`, `writeMemoryRecord` / `readMemoryRecord` / `listMemoryIds` / `readMemoryRecords`, absent/malformed → safe `null`/`[]`). Pure lifecycle logic: `memoryStatus` (derived freshness) / `touchMemory`, `supersede` / `detectConflicts`, `auditMemory` → `AuditReport`, `projectLearnings` (active records → the `LEARNINGS.md` view). Mirrors `run-report.ts`; the directory **is** the list. |
| [`memory-cli.ts`](../packages/core/src/memory-cli.ts)             | `otto-memory` command: pure `formatAuditReport(report)` → string, plus `runMemory(argv, deps)` with `audit` (stale / conflicting / frequently-used report) and `project` (render active records to a raw `LEARNINGS.md`) subcommands. Read-only, mirrors `runInspect`.                                                                  |
| [`eval.ts`](../packages/core/src/eval.ts)                         | Pure eval scoring: `scoreTrajectory(manifest, stages)` → `EvalSignals` (succeeded/cost/tokens/elapsed/error counts), and `compareTrajectories(labelled[])` → a markdown comparison table marking best/worst per directional signal. No I/O, no model calls. **Inert** (only `eval-run.ts` uses it).                                                                  |
| [`bench.ts`](../packages/core/src/bench.ts)                       | Benchmark task model: `BenchmarkTask` / `BenchmarkExpect` / `BenchmarkCheck` types + `parseBenchmarkTask` / `parseBenchmarkSuite` / `readBenchmarkSuite` (schema validation), `runFixtureChecks` (run each check command in the fixture; exit 0 = pass), and the pure `evaluateExpectation` (signals + checks → PASS/FAIL verdict).                                                                  |
| [`eval-run.ts`](../packages/core/src/eval-run.ts)                 | `otto-eval` command (the paid, model-dependent half — never CI): `runEval(argv, deps)` replays each suite task under each config (injectable invoker), scores its evidence bundle, runs fixture checks, and prints a per-task comparison + verdicts. `parseEvalConfigs` validates the config matrix.                                                                  |
| [`risk.ts`](../packages/core/src/risk.ts)                         | Adaptive router risk substrate: `classifyRisk(changedPaths)` → class + level, `reviewDepthForLevel`, `selectLenses`, and `routeReview` (paths → depth + lens subset). Pure, deterministic from paths. **Inert** until the loop opts in.                                                                  |
| [`progress.ts`](../packages/core/src/progress.ts)                 | Adaptive router progress signals: `deriveProgress(cur, prev)` → diffChanged / checksDelta / repeatedFailure / recurringFindings / costBurnRate. Pure.                                                                  |
| [`policy.ts`](../packages/core/src/policy.ts)                     | Adaptive router policy: `decide(signals, ctx)` → continue / stop-low-progress / escalate-pause / finish-confident (precedence escalate > finish > stop > continue). Pure.                                                                  |
| `__tests__/`                                                      | Vitest suites covering CLI parsing, loop/runtime behavior, templates, providers, runner parsing, and helpers.                                                                                                                                             |

`index.ts` re-exports the public runtime surface, including:

```ts
export { runAfk } from "./main.js";
export { runGhAfk } from "./gh-main.js";
export { runLinearAfk, type RunLinearAfkOptions } from "./linear-main.js";
export { runLoop, type LoopOptions, type LoopOutcome } from "./loop.js";
export { STAGES, type Stage } from "./stages.js";
export {
  renderTemplate,
  type RenderOptions,
  type RenderVars,
} from "./render.js";
export { runStage, type StageResult } from "./runner.js";
export {
  emptyTokenUsage,
  parseTokenMode,
  parseTokenUsage,
  type TokenMode,
  type TokenUsage,
} from "./tokens.js";
export {
  allocateRunId,
  writeManifest,
  readManifest,
  writeStageRecord,
  readStageRecords,
  listRunIds,
  type RunManifest,
  type StageRecord,
  type RunArtifact,
} from "./run-report.js";
export { formatRunReport, runInspect } from "./inspect.js";
export { formatAuditReport, runMemory } from "./memory-cli.js";
export {
  allocateMemoryId,
  auditMemory,
  detectConflicts,
  memoryStatus,
  projectLearnings,
  supersede,
  touchMemory,
  type AuditReport,
  type MemoryRecord,
} from "./memory.js";
```

`keepalive` / `detach` / `notify` / `retry` / `cli-help` are deliberately **not** part of the public surface.

---

## AFK machinery

Designed for unattended overnight runs. Four flags wire it up: `--no-keep-alive`, `--max-retries <N>`, `--detach` (+ `--log <path>`), `--notify`.

### Retries — [`retry.ts`](../packages/core/src/retry.ts)

`withRetries(fn, opts)` calls `fn` up to `max + 1` times. Default `DEFAULT_MAX_RETRIES = 3` (override with `--max-retries`; `0` disables retries / restores fail-fast). The backoff schedule is fixed:

```ts
export const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000]; // 5s, 30s, 2m
```

`backoffMs[i]` is the wait **before** attempt `i+1`; once attempts exceed the array length the last value (`120_000`) repeats. `onAttempt(attempt, err)` fires after each failed attempt (before the wait) — `loop.ts` uses it to print a `[retry]` marker and append it to the stage log.

### Wake-lock — [`keepalive.ts`](../packages/core/src/keepalive.ts)

`acquire()` spawns a long-lived child that holds a system-sleep inhibitor for the loop's lifetime; `release()` kills it. Per platform:

| Platform | Mechanism                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Windows  | `powershell` holding `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` in a sleep loop. |
| macOS    | `caffeinate -i -w <parentPid>`.                                                                      |
| Linux    | `systemd-inhibit --what=sleep --mode=block sleep infinity`.                                          |

A missing utility (`ENOENT`) or early child exit degrades to a no-op with a one-time `[keepalive]` warning — the loop never crashes. WSL2 is detected via `/proc/version` and warns that `systemd-inhibit` blocks WSL idle only, not the Windows host. Skip entirely with `--no-keep-alive`.

### Detach — [`detach.ts`](../packages/core/src/detach.ts)

`--detach` forks the bin into a background process (`spawn(execPath, [binEntry, ...argv], { detached: true })`), redirects child stdout+stderr to the log file, prints `detached pid <pid>, log <path>`, and exits the parent **0**. `stripDetachFlags` removes `--detach` and `--log <value>` from the re-spawned argv so the child cannot fork again. Default log path: `<workspace>/.otto-tmp/logs/detached-<parent-pid>.log` (override with `--log`, only valid with `--detach`).

### Notify — [`notify.ts`](../packages/core/src/notify.ts)

`--notify` fires a best-effort OS toast + a terminal bell (`\x07` to stderr) on terminal events:

- `notifyComplete` on sentinel hit or iteration-cap reached.
- `notifyError` on SIGINT/SIGTERM or an uncaught loop error.

Toast backends: Windows BurntToast (fallback `msg.exe`), macOS `osascript display notification`, Linux `notify-send`. All fire-and-forget; missing utilities are swallowed.

### Signal handling — [`loop.ts`](../packages/core/src/loop.ts)

`runLoop` installs `SIGINT` / `SIGTERM` handlers and an `AbortController` (`stageAbort`):

- **SIGINT** → abort the active stage, `notifyError("interrupted (SIGINT)")` if `--notify`, release wake-lock, `process.exit(130)`.
- **SIGTERM** → abort active stage, `notifyError("terminated (SIGTERM)")` if `--notify`, release wake-lock, `process.exit(143)`.

Aborting flows the `stageAbort.signal` into `runStage`; `streamClaude` listens for `abort` and **kills the `claude` child**, rejecting with an `AbortError`. The wake-lock is released through a single `releaseOnce` guard shared by both handlers and the `finally` block, so the inhibitor child is killed exactly once. Handlers are removed via `process.off` in `finally`.

### Rate-limit wait — [`rate-limit.ts`](../packages/core/src/rate-limit.ts) + [`loop.ts`](../packages/core/src/loop.ts)

`rate-limit.ts` monitors the NDJSON stream for Claude session/rate-limit signals and extracts the `resetsAt` timestamp, throwing a `RateLimitError` that `loop.ts` catches between stage attempts.

On catching a `RateLimitError`, `loop.ts`:

1. Prints `⏸ rate limit — waiting ~Nm until reset` and computes the wait duration.
2. If the wait exceeds `--max-wait` (env `OTTO_MAX_WAIT`, default **6h**; accepts bare seconds or `90m`/`6h` strings), it saves resume state via `state.ts` and halts cleanly instead of waiting indefinitely.
3. Otherwise it sleeps until `resetsAt`, holding the OS wake-lock (Ctrl-C / SIGTERM still abort), then retries the **same** iteration — no work is skipped.

### Resume state — [`state.ts`](../packages/core/src/state.ts)

`state.ts` reads and writes `.otto/state.json` (gitignored, created lazily) in the workspace. The file records: bin name, mode, `inputs` string, current iteration, total iterations, status (`running` / `waiting-rate-limit` / `interrupted` / `complete`), and `resetsAt` (when set).

On startup, `loop.ts` calls `matchesResume` to decide whether the saved state matches the current invocation (same bin, mode, and inputs). On a match it resumes from the saved iteration, printing `▶ resuming from iteration N/M`. A mismatch or absent file starts fresh without error. `--fresh` (flag) forces a clean start regardless. State is deleted on normal completion.

**Committed work is never redone.** Resuming is safe because the implementer reconciles against git history and the working tree before selecting a task — plan checkboxes are treated as hints, not truth. Git is the authoritative record of what has been done.

---

## Template renderer

[`render.ts`](../packages/core/src/render.ts). Templates live in [`../packages/core/templates`](../packages/core/templates). `renderTemplate(templatePath, vars, opts)` reads the file and applies five tag forms **in this fixed order** (order matters — `@spill` resolves before shell tags, and the try-shell regex matches before the plain one):

| #   | Tag                                        | Behavior                                                                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@include:<path>`                          | Inline a file via `readFileSync`. Relative paths resolve against the template's dir. **No shell.** Trailing newline trimmed. Used to inject the playbooks.                                                                                        |
| 2   | `@spill[?]:<name>=`<cmd[\|\|\|fallback]>`` | Run `cmd` on the host shell, write stdout to `spillHostDir/<name>`, and substitute the workspace-relative path `./<spillRefPath>/<name>` into the prompt. The `?` form treats non-zero exit as success and writes `fallback` instead of throwing. |
| 3   | `!?`<cmd[\|\|\|fallback]>``                | Try-shell. `execSync` with stderr suppressed; non-zero exit substitutes the literal `fallback` string. Matches **before** the plain `!` form.                                                                                                     |
| 4   | `!`<cmd>``                                 | Plain shell. `execSync` with `cwd = workspaceDir`. Failure **throws and aborts the iteration**.                                                                                                                                                   |
| 5   | `{{ INPUTS }}`                             | Replaced with `vars.INPUTS` (the `inputs` string passed to `runLoop`).                                                                                                                                                                            |

`resolveShell()`: `/bin/bash` on Linux/macOS; on Windows it walks `PATH` (`;`-split) for the first `bash.exe` (Git for Windows / WSL passthrough), falling back to `cmd.exe`. **Templates should prefer `!?` over `!`** for any command that may be unavailable on `cmd.exe`. Shell tags cap output at `maxBuffer = 64 MiB`.

**`@spill` security check:** the `<name>` must be a plain filename — any `/`, `\`, `.`, `..`, embedded `..`, or absolute path throws. Templates are trusted (shipped in the tarball) but this is defense-in-depth to keep writes confined to the per-iteration spill dir. `runLoop` supplies a fresh per-stage `spillHostDir` (`<workspace>/.otto-tmp/spill-<pid>-<iter>-<stageIdx>-<ts>/`) and `spillRefPath` (`.otto-tmp/spill-…`, POSIX) on every render; using `@spill` without them throws.

### What the shipped templates actually do

**[`afk.md`](../packages/core/templates/afk.md)** — try-shell for recent commits, the `{{ INPUTS }}` block, then `@include:prompt.md`:

```
!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`
...
{{ INPUTS }}
@include:prompt.md
```

**[`ghafk.md`](../packages/core/templates/ghafk.md)** — a **two-view issue model** to keep the prompt lean: an inline summary index plus a spilled full dump.

```
<issues-summary>
!?`gh issue list --state open --limit 50 --json number,title,labels|||[]`
</issues-summary>

<issues-full-file>
Full issue bodies + comments spilled to:
@spill?:issues.json=`gh issue list --state open --limit 50 --json number,title,body,labels,comments|||[]`
</issues-full-file>
@include:ghprompt.md
```

The agent triages from the inline `<issues-summary>`, then `Read`s the spilled `issues.json` (with `offset`/`limit`) for bodies/comments before picking a task — so large issue bodies never bloat the prompt token count.

**[`review.md`](../packages/core/templates/review.md)** — `HEAD`, recent commits, `git show --stat HEAD` inline, and the **full HEAD patch spilled** to `head.diff`:

```
!?`git rev-parse HEAD|||(no commits)`
!?`git show --stat HEAD|||No diff`
Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`
```

The reviewer reviews only the latest commit; emits `<review>OK</review>` / `<review>SKIP</review>` and stops, or fixes defects and commits a new `fix(review): …` (never amends).

**[`verify.md`](../packages/core/templates/verify.md)** (`otto-afk --verify`) — read-only gate: reconciles the plan against git + working tree, runs the suites, classifies each task done/gap/deferred, and writes a report to `.otto-tmp/verify-report.md`. Makes no commits.

**[`apply-review.md`](../packages/core/templates/apply-review.md)** (`otto-afk --apply-review <doc>`) — gate that triages an external code-review document, fixing one actionable finding per iteration (`fix(review):`), recording deferred findings in the git-tracked, task-local `.otto/tasks/<task-key>/followups.md`, and emitting the sentinel when none remain.

---

## Native-sandbox runner

[`runner.ts`](../packages/core/src/runner.ts).

### Agent runtime abstraction

The runner does not hardcode `claude`. Everything provider-specific lives behind an `AgentRuntime` object:

```ts
type AgentRuntime = {
  id: AgentRuntimeId; // "claude" | "codex"
  displayName: string; // "Claude Code" | "Codex CLI"
  command: string;
  supportsSandboxSettings: boolean;
  buildArgs(stage, promptRel, modelArgs, settings?): string[];
  parseResultEvent(ev): StageResult; // stamps StageResult.runtimeId
  createStreamParser?(): (ev) => StageResult | undefined;
  resetsAtFromEvent?(ev): number | null;
  buildEnv?(env): NodeJS.ProcessEnv;
};
```

Runtime **selection** is pure config in [`agent-runtime.ts`](../packages/core/src/agent-runtime.ts) (`parseAgentId`, `resolveAgentRuntime` with precedence flag → env → config → default, `readAgentConfig`, `AGENT_DISPLAY_NAMES`, `DEFAULT_AGENT`, plus `resolveFallback`/`readFallbackConfig` for the fallback-on-limit config). The runner's `getAgentRuntime(id)` selects the **adapter**. `claudeRuntime` delegates `buildArgs`→`buildClaudeArgs` and `parseResultEvent`→`resultFromEvent`. `codexRuntime` delegates `buildArgs`→`buildCodexArgs`, uses `createCodexStreamParser()` because Codex's final text and terminal turn event are separate JSONL records, and maps `OPENAI_API_KEY` to `CODEX_API_KEY` for the child process when needed. `streamRuntime(runtime, …)` routes the spawn, stream parse, reset-time extraction, and final-result mapping through the adapter; `supportsSandboxSettings` gates whether the `--settings` sandbox file is written (Claude=`true`, Codex=`false`).

Rate-limit auto-switch orchestration lives in [`loop.ts`](../packages/core/src/loop.ts) and is provider-neutral: it switches the mutable active runtime at the rate-limit boundary only when a fallback adapter is available, persists it to `RunState.agent`, and restores it on resume. Codex reset-time fields are opportunistic; if a Codex limit has no reset hint, the loop uses the standard fallback wait.

### `claude` argv shape

`runStage` writes the rendered prompt to `<workspace>/.otto-tmp/.run-<pid>-<iter>-<ts>.md`, then assembles:

```
claude --verbose --print --output-format stream-json
       --permission-mode <mode>
       [--settings <workspace>/.otto-tmp/.sandbox-<pid>-<iter>-<ts>.json]
       [--model <OTTO_MODEL>]
       "Read the full instructions from the file ./.otto-tmp/<run-file> in the current workspace and execute them."
```

Spawned with `cwd = workspaceDir`. `--permission-mode` is always `bypassPermissions` (from the stage). `--settings` is included only when `OTTO_RUNNER=sandbox` (the default).

### `codex` argv shape

Codex stages use Codex's non-interactive mode and its own sandbox flags:

```
codex --ask-for-approval never
      exec --json --ignore-user-config --skip-git-repo-check
       --sandbox workspace-write|danger-full-access
       [--model <OTTO_MODEL>]
       "Read the full instructions from the file ./.otto-tmp/<run-file> in the current workspace and execute them."
```

`--ask-for-approval` is emitted before `exec` because it is a Codex global flag in current CLI builds; `OTTO_RUNNER=sandbox` maps to `exec --sandbox workspace-write`; `OTTO_RUNNER=host` maps to `exec --sandbox danger-full-access`. Claude-only `--permission-mode` and `--settings` flags are never passed to Codex.

### Sandbox settings (`OTTO_RUNNER=sandbox`)

`buildSandboxSettings(workspaceDir, allowedDomains)` produces a transient JSON file:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": { "allowWrite": ["<workspaceDir>"] },
    "excludedCommands": ["gh *", "gcloud *", "terraform *"]
  }
}
```

`excludedCommands` exempts Go-TLS CLIs from the sandbox so `gh`/`gcloud`/`terraform` keep working (they fail TLS verification under Seatbelt). If `OTTO_SANDBOX_NET` is set, a `network.allowedDomains` block is added; otherwise network egress is unrestricted (filesystem confinement is the blast-radius control; network commands fall back to the bypass-approved escape hatch).

The settings file is written to `.otto-tmp/` and deleted in `finally`.

### NDJSON streaming — `streamRuntime`

`spawn(runtime.command, args, { cwd, stdio: ["ignore","pipe","pipe"] })`. stdout is read line-by-line; lines starting with `{` are appended to the NDJSON log and `JSON.parse`d:

- **assistant `text`** → printed to **stdout** with a `●` bullet (the visible answer stream).
- **`tool_use` / `tool_result` / `thinking` / `system:init`** → rendered to **stderr** (tool name + truncated input/result preview + elapsed ms).
- **`result`** event → its `result` string is captured as the stage's return value. `total_cost_usd`, error fields, and `usage` token fields are parsed into `StageResult`.
- **Codex `item.completed` agent_message + `turn.completed`** → the last agent message becomes `StageResult.result`; the terminal turn event supplies token usage. `turn.failed` / `error` becomes an errored `StageResult` so the same retry/rate-limit path applies.

Codex stages pass `exec --ignore-user-config` so unattended Otto runs do not load a user's personal Codex MCP/plugin config. Auth still comes from Codex's normal auth sources (`~/.codex/auth.json`, `CODEX_API_KEY`, or Otto's `OPENAI_API_KEY` compatibility mapping).

Color is **TTY-gated and stream-split**: `USE_COLOR` (stderr) and `USE_COLOR_STDOUT` (stdout) are independent, so `otto-ghafk 1 > out.txt` stays clean even on a TTY. ANSI is disabled when `NO_COLOR` is set or `TERM=dumb`.

**Post-result grace timer:** when the runtime emits its final event (`result` for Claude, `turn.completed` / `turn.failed` / `error` for Codex), a one-shot timer (`OTTO_RESULT_GRACE_MS`, default **30000 ms**; `0` disables) is armed. If the child emits its final NDJSON but never exits, the timer kills it and resolves with the captured result so the loop is not hung. On non-zero exit, `streamRuntime` rejects with the last ~40 stderr lines.

### Token accounting and reduction

`--token-mode` controls token observability:

- `off` (default) preserves current output and prompt rendering.
- `measure` aggregates the `usage` object from each Claude `result` event and prints per-stage plus end-of-run input/output/cache token counts.
- `reduce` does the same accounting and applies conservative prompt compaction in `stage-exec.ts` after `renderTemplate()`.

The reducer only removes redundant whitespace/trailing spaces from rendered prompts. It never caches implementer/reviewer/verifier/synth outputs, skips required context, or replaces source/diff/issue bodies with hidden summaries. Cache-read/cache-create token counts are displayed separately because provider-side cached tokens are not equivalent to fresh input tokens.

---

## Per-iteration scratch layout

Everything lands under `<workspace>/.otto-tmp/` (gitignored):

```
<workspace>/.otto-tmp/
├── .run-<pid>-<iter>-<ts>.md             rendered prompt (deleted in finally; may leak on SIGKILL)
├── spill-<pid>-<iter>-<stageIdx>-<ts>/   per-stage @spill outputs (deleted in finally)
│   └── <name>                            e.g. issues.json, head.diff
└── logs/
    ├── <ts>-iter<N>-<stage>.ndjson       full NDJSON stream log (kept)
    └── detached-<pid>.log                child stdout+stderr (only in --detach mode)
```

`.run-*.md` and `spill-*/` are removed in `runStage`'s `finally`; the NDJSON logs are kept for inspection. A leaked `.run-*.md` after a hard kill is safe to delete.

On startup, `run-bin.ts` ensures `.otto-tmp/` is listed in the workspace `.gitignore` (appending an entry if absent). `.otto/` is never gitignored — it holds git-tracked files (`LEARNINGS.md`, `config.json`). In `worktree` mode, `branch.ts` creates the worktree at `<workspace>/.otto-tmp/worktrees/<slug>` on branch `<prefix><slug>`; the worktree is not auto-removed after the run (`git worktree remove <path>` to clean up).

---

## Run evidence bundle

Distinct from the ephemeral `.otto-tmp/` scratch, every run writes a durable, structured record of its trajectory — what Otto observed, decided, executed, spent, and left unresolved — under `<workspace>/.otto/runs/<run-id>/`. The raw `.otto-tmp/logs/*.ndjson` stream stays untouched for low-level debugging; the bundle is the compact "what happened?" layer above it. `.otto/runs/` is gitignored (added by `run-bin.ts` alongside `state.json`); the bundle lives in `.otto/` so it survives the per-iteration scratch cleanup. The substrate is [`run-report.ts`](../packages/core/src/run-report.ts).

```
<workspace>/.otto/runs/<run-id>/
├── manifest.json                    one RunManifest (the run-level record)
└── stages/
    ├── 0000-iter1-implementer.json  one StageRecord per stage, seq-ordered
    ├── 0001-iter1-reviewer.json
    └── …
```

**Run id.** `allocateRunId()` is an ISO timestamp with `:`/`.` replaced by `-`, suffixed with the pid (e.g. `2026-06-19T08-39-45-123Z-13793`). This is **lexicographically sortable** — so `latest` is a plain string sort (`listRunIds().at(-1)`) — and pid-suffixed so concurrent runs on one host never collide. A fresh id is allocated per `runLoop` invocation (not reused across resume).

**Manifest.** Written once at loop start with the run identity (bin, mode, inputs, runtime, branch strategy, planned `iterations`, `startedAt`), then **finalized** on every clean terminal path — `summarize` calls a best-effort `finalizeManifest` that rewrites the whole file with `completedIterations`, cost/token totals, `exitReason` + `nextAction`, the active runtime (post-auto-switch), artifact links, and `finishedAt`. The `stages/` directory **is** the stage list; the manifest does not duplicate it.

**Stage records.** A `recordStage` closure in `runLoop` normalizes each `StageResult` into a `StageRecord` and writes it under `stages/`. The seq prefix zero-pads so records sort in execution order; the stage segment of the filename is sanitized to `[A-Za-z0-9_-]` because review-panel lens names (from `OTTO_REVIEW_LENSES`) are free text. The review panel records its own lens / verify / synth substages by name rather than an umbrella "reviewer" record. The gate stage is recorded even when it emits the completion sentinel.

**Best-effort, never fatal.** Every bundle write (initial manifest, each stage record, finalize) is wrapped in `try/catch` and swallows — a bundle write must never break a run. **Known gap:** the `process.exit()` interrupt paths (SIGINT / SIGTERM / keyboard quit) bypass `summarize`, so an interrupted run leaves only the initial, un-finalized manifest.

**Inspect.** `otto-inspect [<run-id>|latest]` ([`inspect.ts`](../packages/core/src/inspect.ts)) reads a bundle and prints a compact human report answering "what happened and why did Otto stop?". No arg or `latest` resolves to the newest run. A pure `formatRunReport(manifest, stages)` does the rendering (no I/O); `runInspect` resolves `OTTO_WORKSPACE ?? cwd`, reads, and prints. An un-finalized run renders honestly — it shows `? / <planned>` iterations and suppresses the `exit:`/`next:` lines rather than inventing an exit reason.

---

## Harness evaluation suite

Built on the evidence bundle: a way to measure **harness quality** (task success, cost, latency, safety) across Otto configurations — separate from the model. The suite has two halves with deliberately different properties.

**Deterministic (CI-runnable, free).** A pure scoring substrate over a *recorded* trajectory — no model calls. [`eval.ts`](../packages/core/src/eval.ts) derives `EvalSignals` from a bundle (`scoreTrajectory`) and renders a cross-config markdown comparison (`compareTrajectories`, best/worst per directional signal). [`bench.ts`](../packages/core/src/bench.ts) adds the fixture-derived half: `evaluateExpectation` scores signals + check results against a `BenchmarkExpect` into a PASS/FAIL verdict. [`scripts/benchmarks-suite.test.mjs`](../scripts/benchmarks-suite.test.mjs) (run by `pnpm test`) pins all of this plus the structural validity of [`benchmarks/`](../benchmarks) — the manifest parses, every fixture exists, the safety check passes on the clean tree, a code fixture's check fails unfixed (so it has signal).

**Model-dependent (manual/paid, never CI).** Actually replaying the fixture tasks. `otto-eval <suite.json> [<configs.json>] [--iterations <n>]` ([`eval-run.ts`](../packages/core/src/eval-run.ts)) loads the [`benchmarks/`](../benchmarks) suite and a config matrix, replays each task under each config (via an injectable invoker that spawns the otto bin in the fixture), reads the evidence bundle each run writes under `<fixture>/.otto/runs/`, scores it with `scoreTrajectory`, runs the task's `runFixtureChecks`, and prints a per-task comparison table plus a PASS/FAIL verdict per config. It exits non-zero if any expectation is unmet.

```
benchmarks/
├── suite.json        the BenchmarkTask[] manifest
├── configs.json      the config matrix (baseline / panel / host / …)
└── fixtures/<id>/    one self-contained fixture repo per task
```

The six fixtures cover the representative jobs from the roadmap: a small bug fix with tests, a multi-file feature, a failing-review repair, issue-intake triage, a rate-limit/resume resilience sim, and a prompt-injection-in-issue-body safety sim. Code fixtures ship a deliberately failing test the run must make pass; the ghafk/sim fixtures document their manual setup in a per-fixture `README.md`. See [`benchmarks/README.md`](../benchmarks/README.md) for how to run the paid suite and add a benchmark. **Gotcha:** fixture checks inherit the calling process's env; a `node --test` check no-ops if `NODE_TEST_CONTEXT` is inherited (only relevant when running checks from within another `node --test` — the bin path is unaffected).

---

## Adaptive compute router

Opt-in via `--adaptive-router` (or `OTTO_ADAPTIVE_ROUTER=1`); **off by default**, so the fixed "N iterations + static review chain" behavior is unchanged unless asked for. The router allocates review/iteration compute by evidence rather than configuration. Every decision is a pure function of model-free signals (changed paths, diff stability, cost) so it is reproducible and the eval suite can A/B `adaptive` vs `baseline` deterministically. Three pure substrates:

- **Risk → review depth** ([`risk.ts`](../packages/core/src/risk.ts)). Each iteration, `routeReview(changedPaths, lensPool)` classifies the change and routes its review depth. Classification precedence (highest-risk class wins, so a sensitive path can't be masked by a co-changed benign one): security-sensitive → migration-release → docs-only / test-only / cross-module / narrow-code → unknown. Levels map to depth: low → **single** reviewer, medium → a capped **lens subset**, high → the **full panel**. An empty path set (no visible diff) is `unknown` → high, conservatively.
- **Progress signals** ([`progress.ts`](../packages/core/src/progress.ts)). `deriveProgress(cur, prev)` derives `diffChanged`, `checksDelta`, `repeatedFailure`, `recurringFindings`, and `costBurnRate` from per-iteration observations.
- **Policy** ([`policy.ts`](../packages/core/src/policy.ts)). `decide(signals, ctx)` returns `continue` / `stop-low-progress` / `escalate-pause` / `finish-confident`, with precedence escalate > finish > stop > continue.

**Loop wiring.** `loop.ts` captures HEAD at each iteration start; at the reviewer stage it routes the lens subset from `changedFilesSince(iterStartSha)` (an injectable `resolveChangedPaths` seam keeps it unit-testable), and at iteration end it feeds progress into the policy. The active outcome today is the **diff-stall early stop**: a run that produces no diff for two consecutive iterations ends as `stopped (low progress)` instead of burning the remaining iterations. `failingChecks` / `failureSignature` / finding recurrence are plumbed through the pure layer but not yet observed from stage output (the loop does not run the project's tests), so `escalate-pause` / `finish-confident` are inert until that observability lands — a deliberate, honest gap.

---

## Governed memory lifecycle

Otto's repo learning has two layers. The flat, hand-curated `.otto/LEARNINGS.md` is the human-readable memory injected verbatim into every prompt (via the `<learnings>` block — see the template renderer above). Underneath it, a **governed memory** substrate ([`memory.ts`](../packages/core/src/memory.ts)) treats each learning as a structured record with provenance, scope, and a lifecycle — so memory can be audited and bounded instead of growing as an append-only blob that contaminates unrelated runs with stale or untrusted assumptions.

Each record is one git-tracked JSON file under `<workspace>/.otto/memory/<id>.json` (durable like `LEARNINGS.md`, **not** `.otto-tmp/`). The **directory is the list** — there is no central index to keep in sync — exactly like `.otto/runs/<id>/stages/`. `allocateMemoryId(date, suffix)` uses the same sortable-ISO-stamp scheme as `allocateRunId`. Every reader (`readMemoryRecord` / `readMemoryRecords` / `listMemoryIds`) returns a safe empty value on an absent or malformed file and never throws — a memory read must not break a run.

A `MemoryRecord` carries three **orthogonal** governance axes the issue calls for — don't collapse them:

- **`trust`** — a coarse provenance band: `trusted` / `unverified` / `deprecated`.
- **`confidence`** — a `0..1` scalar.
- **`status`** — the lifecycle: `active` / `stale` / `superseded`.

plus `sourceRun`, `taskKey`, `scope[]` (the files/modules a record applies to), timestamps (`createdAt` / `lastUsedAt`), a `useCount`, and a freshness policy (`expiresAt` absolute, `revalidateAfterDays` sliding).

**Freshness is derived, not stored.** `memoryStatus(record, now)` recomputes `active` vs `stale` from the policy at read time (past `expiresAt`, or `revalidateAfterDays` elapsed since last use) — it does **not** trust the stored `status`, except `superseded`, which is terminal. `touchMemory` returns a copy with `lastUsedAt` / `useCount` bumped (sliding the revalidation window) without mutating in place. An unparseable timestamp is ignored, never treated as expired.

**Contradiction handling.** `supersede(newer, older)` marks `older.status = "superseded"` and points `newer.supersedes` at it. `detectConflicts(records)` pairs active records with the same `category` + `scope` set but **different** `content` — identical content is agreement, not a conflict.

**Audit.** `auditMemory(records, now)` → an `AuditReport` of `stale[]`, `conflicting[]`, and `frequentlyUsed[]` records plus counts. `otto-memory audit` ([`memory-cli.ts`](../packages/core/src/memory-cli.ts)) renders it via a pure `formatAuditReport`, so a maintainer sees stale or conflicting entries *before* they influence a run. (Deliberate asymmetry: `stale` and the counts use the **derived** `memoryStatus`, while `conflicting` uses the **stored** status — an audit must catch a record that is past its policy but still stored `active`.)

**Projection + compaction.** `projectLearnings(records, now)` renders only the **active** records (derived-stale and superseded dropped) into the canonical four-section `# Otto learnings` view; `otto-memory project` prints it raw so it can be redirected into `.otto/LEARNINGS.md`. This is what keeps prompt size from memory bounded and explainable. The four **compaction tiers** — active context (the prompt) → summarized state (`LEARNINGS.md`) → reconstructable artifacts (`.otto-tmp/logs` + `.otto/runs`) → durable memory (`.otto/memory/<id>.json`) — are documented for the agent in the shared [`templates/governed-memory.md`](../packages/core/templates/governed-memory.md) fragment, `@include`d by both playbooks' LEARNINGS sections (`prompt.md` for afk, `ghprompt-workflow.md` for every `*afk*` provider mode).

**Inert on the read path.** The substrate is wired into the read-only `otto-memory` bin and the playbook prose that *writes* records, but the loop still injects `LEARNINGS.md` verbatim — a memory record never gates or alters a run. `projectLearnings` is offered as a command, not auto-run over `LEARNINGS.md` (which would clobber the hand-curated superset). Pinned by `memory.test.ts` / `memory-cli.test.ts` / `governed-memory.test.ts`.

---

## Conventions to preserve

- **ESM only.** Both packages are `"type": "module"`; relative imports in `packages/core/src` end in `.js` (NodeNext).
- **First stage is the gate.** Place gating stages at index 0 of any chain. The sentinel `<promise>NO MORE TASKS</promise>` is hardcoded in [`../packages/core/src/loop.ts`](../packages/core/src/loop.ts).
- **No build step for `apps/cli`.** Bins are hand-written JS that `import { runAfk } from "@phamvuhoang/otto-core"`. Keep the bin layer flat — don't add TS there.
- **`permissionMode` is always `bypassPermissions`** for all stages — AFK requires non-interactive bash/edit approval; blast radius is bounded by the runner sandbox and the workspace is git-recoverable. Never `acceptEdits`.
- **Templates ship in the core tarball.** `packages/core/package.json` `files` includes `dist` and `templates`.
- **Adding a stage** = (1) extend `STAGES` in [`../packages/core/src/stages.ts`](../packages/core/src/stages.ts), (2) drop a new `*.md` in [`../packages/core/templates`](../packages/core/templates), (3) wire it into the chain in `main.ts` / `gh-main.ts`.

---

## Building and testing

Verification = typecheck + unit tests + manual bin invocation (no separate lint command; formatting runs via the pre-commit hook).

Build core (`apps/cli` has no build):

```bash
pnpm install
pnpm -r build        # tsc -p packages/core/tsconfig.json → dist/
pnpm -r typecheck    # tsc --noEmit across the workspace
```

Run tests (core: vitest; root: `node --test` over `scripts/*.test.mjs`):

```bash
pnpm --filter @phamvuhoang/otto-core test   # vitest run, src/__tests__/*.test.ts
pnpm test                                # root: node --test scripts/*.test.mjs
```

The pre-commit hook ([`../.husky/pre-commit`](../.husky/pre-commit)) runs `pnpm exec lint-staged` (Prettier `--write` on staged files) then `pnpm typecheck`. The root `prepare` script is `husky || git config core.hooksPath .husky` so installs still work if Husky does not self-initialize.

Diagnose resolved config (workspace / runner / sandbox config) without running a loop:

```bash
otto-afk --print-config
```

Release/publishing (release-please → tag-driven npm workflows) is the single-source-of-truth concern of [`../RELEASING.md`](../RELEASING.md).

---

## Environment variables

| Variable                 | Default          | Effect                                                                                                                                                                            |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTO_WORKSPACE`         | `process.cwd()`  | Host dir Claude runs against (`cwd`); root for `.otto-tmp/`.                                                                                                                      |
| `OTTO_RUNNER`            | `sandbox`        | `sandbox` — native OS sandbox (Seatbelt on macOS), writes confined to the workspace. `host` — unsandboxed.                                                                        |
| `OTTO_SANDBOX_NET`       | — (unrestricted) | Comma-separated domain allowlist for sandbox network egress. Unset = unrestricted (filesystem is the blast-radius control).                                                       |
| `OTTO_RESULT_GRACE_MS`   | `30000`          | Post-result kill timer; `0` disables. Invalid/negative → default.                                                                                                                 |
| `OTTO_AGENT`             | `claude`         | Agent CLI runtime (`claude` \| `codex`); selects the `AgentRuntime` adapter. Precedence `--agent` → env → `.otto/config.json` → default. See the runtime abstraction above.       |
| `OTTO_MODEL`             | — (CLI default)  | `--model <value>` pass-through to the active runtime for every stage. Empty/whitespace = unset. `OTTO_CLAUDE_MODEL` / `OTTO_CODEX_MODEL` override it per runtime.                 |
| `OTTO_MAX_WAIT`          | `6h`             | Maximum time to wait for a Claude rate-limit to clear before halting and saving resume state. Accepts bare seconds or duration strings (`90m`, `6h`). Equivalent to `--max-wait`. |
| `OTTO_BRANCH`            | — (`current`)    | Branch isolation strategy: `current`, `branch`, or `worktree`. Overrides `.otto/config.json`; overridden by `--branch`.                                                           |
| `OTTO_BRANCH_PREFIX`     | `otto/`          | Prefix for the generated branch/worktree name. Overrides `.otto/config.json`; overridden by `--branch-prefix`.                                                                    |
| `NO_COLOR` / `TERM=dumb` | —                | Disable ANSI on both streams.                                                                                                                                                     |
