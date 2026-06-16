# CLI reference

Commands, flags, and modes for the two Otto bins. For environment variables, runner/sandbox behavior, and branch strategy see **[CONFIG.md](./CONFIG.md)**.

- [Choosing a mode](#choosing-a-mode)
- [`otto-afk` — plan/PRD loop](#otto-afk--planprd-loop)
- [`otto-ghafk` — GitHub-issue loop](#otto-ghafk--github-issue-loop)
- [Running AFK (detach, notify, retries, resume)](#running-afk)
- [Cost control, pacing & review panel](#cost-control-pacing--review-panel)
- [Verify & apply-review modes](#verify--apply-review-modes)
- [Watch mode](#watch-mode-otto-ghafk-only)
- [Single-issue mode](#single-issue-mode-otto-ghafk-only)
- [Branch strategy](./CONFIG.md#branch-strategy)
- [Stopping a run](#stopping-a-run)
- [Troubleshooting](#troubleshooting)
- [Customizing the pipeline](#customizing-the-pipeline)
- [Source map](#source-map)

Every command also supports `--help` / `-h`, `--version` / `-V`, and `--print-config` (print the resolved config plus a preflight check of run prerequisites — `claude`/`gh` CLIs, credentials, git workspace — then exit). See [CONFIG.md → Prerequisites](./CONFIG.md#prerequisites) for the preflight block.

---

## Choosing a mode

Otto has one build loop with four entry points. They share the same resilience, sandbox, and reconcile-against-git behavior — they differ only in where the task comes from and what the **gate stage** (the first, sentinel-checked stage) does. Pick by where your work lives:

| Mode                                 | Input                                                           | Gate stage                 | When to use                                                                                             |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `otto-afk "<plan-and-prd>" <n>`      | A plan/PRD string (conventionally file paths) + iteration count | `implementer`              | Drive a local plan or PRD to completion, implementing one task per iteration.                           |
| `otto-ghafk <n>`                     | Open GitHub issues (no input arg)                               | `ghafk-implementer`        | Burn down a GitHub issue backlog, one issue per iteration. `--issue` targets one; `--watch` daemonizes. |
| `otto-afk --verify "<plan-and-prd>"` | A plan/PRD string (one-shot — no iteration count)               | `verify` (read-only)       | Audit what actually landed: a DONE/GAP/DEFERRED report + suite run. Changes nothing, no reviewer stage. |
| `otto-afk --apply-review <doc> <n>`  | An external code-review document + iteration count              | `apply-review-implementer` | Fix the actionable findings of an external review, one per iteration; deferred ones tracked in git.     |

`--verify` and `--apply-review` are `otto-afk` modes that swap the gate stage; they are mutually exclusive with each other and with `--issue` / `--watch`. `--review-panel` is orthogonal — it upgrades the **reviewer** stage in any of the above (it reviews Otto's _own_ diff), not the gate. Full per-mode detail follows.

---

## `otto-afk` — plan/PRD loop

```bash
otto-afk "<plan-and-prd>" <iterations>
```

- `<plan-and-prd>` — a single string forwarded verbatim as `{{ INPUTS }}` in the template. Conventionally paths to plan and PRD files.
- `<iterations>` — max loop iterations. Exits early if the implementer emits the sentinel `<promise>NO MORE TASKS</promise>`.

```bash
otto-afk "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

(Or via the shim: `./node_modules/@phamvuhoang/otto/scripts/afk.sh "<plan-and-prd>" <iterations>`.)

### What happens per iteration

1. **Render template** `packages/core/templates/afk.md`:
   - `` !?`git log -n 5 …|||No commits found` `` → recent commits (try-shell)
   - `{{ INPUTS }}` → the plan/PRD string
   - `@include:prompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **Implementer stage** (gate) — `claude` is spawned on the host with the rendered prompt via a tempfile under `.otto-tmp/`. The default `OTTO_RUNNER=sandbox` enables the native OS sandbox. Assistant text is rendered live; the final `result` is captured.
3. **Sentinel check** — if `result` contains `<promise>NO MORE TASKS</promise>`, print `Otto complete after <N> iterations.` and exit 0.
4. **Reviewer stage** — runs `review.md`. Reads the HEAD commit (the `git show --stat` summary inline, the full patch spilled to `.otto-tmp/spill-…/head.diff`), then either commits a `fix(review): …` patch or emits `<review>OK</review>` / `<review>SKIP</review>` and stops. Single pass; never amends the implementer's commit.

---

## `otto-ghafk` — GitHub-issue loop

```bash
otto-ghafk <iterations>
```

No plan/PRD arg — context comes from open GitHub issues.

### What happens per iteration

1. **Render template** `ghafk.md`:
   - recent commits (try-shell)
   - `` !?`gh issue list --state open … --json number,title,labels|||[]` `` → a lean inline index of open issues
   - `` @spill?:issues.json=`gh issue list … --json number,title,body,labels,comments` `` → full issue bodies + comments written to `.otto-tmp/spill-…/issues.json`; the agent `Read`s it before picking a task
   - `@include:ghprompt.md` → the agent playbook
2. **ghafk-implementer stage** (gate) — the agent picks one open AFK issue, implements it, commits, and closes / comments on the issue.
3. **Sentinel check** — same as `otto-afk`.
4. **Reviewer stage** — same as `otto-afk`.

---

## Running AFK

Both bins are designed to chew through long runs unattended.

| Flag                | Default                                                | What it does                                                                                                            |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `--no-keep-alive`   | off (wake-lock acquired)                               | Skip the OS wake-lock for the loop's lifetime.                                                                          |
| `--max-retries <N>` | `3`                                                    | Per-stage retry budget on transient failures. `0` restores fail-fast.                                                   |
| `--detach`          | off                                                    | Fork the loop into a background process, print pid + log path, and exit.                                                |
| `--log <path>`      | `<workspace>/.otto-tmp/logs/detached-<parent-pid>.log` | Override the detached log target. Only meaningful with `--detach`.                                                      |
| `--notify`          | off                                                    | OS toast + terminal bell on loop completion or unrecoverable failure.                                                   |
| `--max-wait <dur>`  | `6h`                                                   | Maximum time to wait out a Claude rate-limit before halting. Accepts seconds (`90`) or a duration string (`90m`, `6h`). |
| `--fresh`           | off                                                    | Ignore any saved `.otto/state.json` and restart from iteration 1.                                                       |

Canonical overnight recipe:

```bash
otto-afk --detach --notify "<plan-and-prd>" 50
tail -f <workspace>/.otto-tmp/logs/detached-*.log   # follow from any shell
```

This forks into the background, holds an OS wake-lock so the host doesn't sleep, retries transient stage failures up to 3× with exponential backoff (`5s / 30s / 2m`), and raises a toast + bell when the run finishes or fails. Full per-OS wake-lock notes live in [`keep-alive.md`](./keep-alive.md).

### Resilience & resume

- **Rate-limit wait.** When Claude hits a session or rate limit, Otto detects the exact reset time from the stream, prints `⏸ rate limit — waiting ~Nm until reset`, holds the wake-lock, and resumes the **same** iteration when the limit clears (Ctrl-C still works). If the reset is further out than `--max-wait`, Otto halts cleanly and saves resume state.
- **Resume across restarts.** Otto writes `.otto/state.json` (gitignored) after each iteration. Re-running the same command resumes from where it left off (`▶ resuming from iteration N/M`); a mismatch (different command, fresh clone, absent file) starts fresh without erroring. `--fresh` forces a clean restart.
- **Committed work is never redone.** The implementer reconciles against git history and the working tree before picking a task — plan checkboxes are hints, not truth — so resuming (or re-running) never duplicates committed work. State is cleared automatically on completion.

---

## Cost control, pacing & review panel

| Flag              | Default | What it does                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--budget <usd>`  | off     | Stop the loop once cumulative Claude spend reaches this dollar amount (committed work is kept). Cost is printed per stage.                                                                                                                                                                                     |
| `--cooldown <ms>` | `0`     | Sleep between iterations; grows automatically (×2, capped) when the API signals throttling.                                                                                                                                                                                                                    |
| `--review-panel`  | off     | Replace the single reviewer with a paced panel — read-only `correctness`/`security`/`tests` lenses → an adversarial verify pass (a skeptic refutes findings, defaulting to reject when uncertain) → one `fix(review):` commit that fixes only confirmed defects. Also enabled by setting `OTTO_REVIEW_LENSES`. |

```bash
# cap spend, pace iterations, and use the reviewer panel
otto-afk --budget 10 --cooldown 2000 --review-panel "<plan-and-prd>" 30
```

---

## Verify & apply-review modes

Two alternate `otto-afk` modes reuse the loop's resilience and reconcile-against-git behavior but swap the gate stage. Both are distinct from `--review-panel` (which reviews Otto's _own_ diff). They are mutually exclusive with each other and with `--issue` / `--watch`.

| Flag                   | Default | What it does                                                                                                                                    |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verify`             | off     | Read-only: reconcile the plan against git + working tree, run the test/type suites, and write a report. One pass; takes no iterations argument. |
| `--apply-review <doc>` | off     | Fix the actionable findings of an external code-review document — one finding per iteration — recording deferred ones and skipping cosmetics.   |

### `--verify`

Runs a single read-only pass: classifies every plan task as **DONE** / **GAP** / **DEFERRED** (with `file:line` or commit evidence), runs the suites, and writes a report to `.otto-tmp/verify-report.md` (gitignored scratch). It is _instructed_ not to commit or edit sources — that is a playbook rule, not a hard sandbox guarantee (stages still run with `bypassPermissions`), so treat the no-commit behavior as a strong convention. Any positional iterations count is ignored (verify is one-shot).

```bash
# Re-verify a plan/PRD without changing anything
otto-afk --verify "./docs/plans/feature.md ./docs/prd/feature.md"

# Verify a single plan file; read the verdict + section counts in the final message
otto-afk --verify "./docs/plans/inventory.md"

# Drive a different repo, then read the report
OTTO_WORKSPACE=~/code/other-repo otto-afk --verify "./docs/plans/migration.md"
cat ~/code/other-repo/.otto-tmp/verify-report.md
```

The report looks like:

```
# Verify report
## Verdict
<one-line: all done / N gaps / N deferred>
## Done
- <task> — <evidence: file:line or commit>
## Gaps
- <task> — <what is missing>
## Deferred
- <task> — <why>
## Suites
- <command> — <pass/fail counts>
```

A natural pairing: run an unattended `otto-afk` build, then `--verify` the same plan to get an independent, read-only audit of what actually landed.

### `--apply-review <doc>`

Runs the normal implement→review loop, but the gate triages an external review document. Per iteration it fixes **one** actionable finding (each `fix(review):`-committed, after reconciling against git so already-fixed items are skipped); deferred/follow-up findings are appended to `.otto/review-followups.md` (a git-tracked backlog, committed _with_ the related fix); cosmetic ones are recorded as skipped. The loop ends when no actionable findings remain. `--review-panel`, `--budget`, and `--cooldown` all compose with it.

```bash
# Apply an external code review, fixing actionable findings one per iteration (≤20)
otto-afk --apply-review ./code-review.md 20

# Cap the spend while applying a large review
otto-afk --apply-review ./security-audit.md --budget 8 30

# Apply a review and re-review each fix with the multi-lens panel
otto-afk --apply-review ./pr-142-review.md --review-panel 25

# Feed it the output of a security review of the current branch
/security-review > review.md          # or any reviewer that emits a findings doc
otto-afk --apply-review ./review.md 15
```

After the run, inspect the tracked backlog of everything it intentionally deferred:

```bash
cat .otto/review-followups.md
```

---

## Watch mode (`otto-ghafk` only)

Run as a daemon that idles, polls GitHub for labelled open issues, and runs the loop when work appears:

```bash
otto-ghafk --watch --watch-interval 300 5     # poll every 5 min, ≤5 iterations per trigger
```

The trigger label defaults to `otto` (`OTTO_WATCH_LABEL` to change it). Under `--watch`, `--budget` caps total spend across the whole session; `Ctrl+C` stops cleanly. Cannot be combined with `--issue`.

---

## Single-issue mode (`otto-ghafk` only)

Point the loop at one GitHub issue instead of triaging all open ones:

```bash
otto-ghafk --issue 42 5                                         # bare number
otto-ghafk --issue "#42" 5                                      # hash form
otto-ghafk --issue owner/repo#42 5                              # cross-repo reference
otto-ghafk --issue https://github.com/owner/repo/issues/42 5    # full URL
```

The loop fetches only that issue and exits when it is complete (the agent emits `<promise>NO MORE TASKS</promise>`). Cannot be combined with `--watch`.

---

## Stopping a run

- **Natural stop:** implementer emits `<promise>NO MORE TASKS</promise>`.
- **Manual stop:** `Ctrl+C`. `runLoop` installs `SIGINT` / `SIGTERM` handlers that abort the active stage (via `AbortController`, killing the `claude` child), release the OS wake-lock, fire the `--notify` toast if enabled, and exit `130` (SIGINT) / `143` (SIGTERM). Tempfiles under `.otto-tmp/.run-*.md` and the per-stage `spill-*/` dir are removed by the `finally` block; a hard `SIGKILL` may leave them — safe to delete, gitignored.

---

## Troubleshooting

- **`Cannot find module '@phamvuhoang/otto-core'`** — `@phamvuhoang/otto` was installed but its dep didn't resolve. Re-run `npm install` (or `pnpm install`) in the workspace, or use `npx -y @phamvuhoang/otto` to fetch a clean copy.
- **`Not logged in · Please run /login`** — Claude credentials missing. Run `claude /login` on the host (see [CONFIG.md → First-run setup](./CONFIG.md#first-run-setup)).
- **`gh issue list` fails with `not a git repository`** — the workspace has no `.git`. The `ghafk.md` template falls back to `[]` so the iteration still proceeds, but `gh` cannot detect the target repo. Initialize the repo, or push first.
- **Loop hangs after a stage's final assistant message** — the `claude` CLI emitted its final NDJSON `result` event but failed to exit. The runner self-recovers within `OTTO_RESULT_GRACE_MS` (default 30000ms). Work already committed is preserved.

---

## Customizing the pipeline

### Add a stage

1. Add an entry to `STAGES` in `packages/core/src/stages.ts`:
   ```ts
   linter: { name: "linter", template: "lint.md", permissionMode: "bypassPermissions" } satisfies Stage,
   ```
2. Create `packages/core/templates/lint.md` using the same `` !`cmd` `` + `{{ INPUTS }}` syntax.
3. Wire it into the chain in `main.ts` / `gh-main.ts`:
   ```ts
   stages: [STAGES.implementer, STAGES.linter, STAGES.reviewer],
   ```
4. `pnpm -r build` and republish.

Only the first stage is the gate (sentinel-checked). Subsequent stages always run after a non-sentinel gate result. All stages use `permissionMode: "bypassPermissions"`; the blast radius is bounded by the runner sandbox and the git-recoverable workspace.

### Template syntax

The renderer (`packages/core/src/render.ts`) expands tags in a fixed order: `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`.

- `` !`<shell cmd>` `` — executed via `bash` (or `cmd.exe` on Windows) with `cwd = workspaceDir`. stdout (trailing newline trimmed) replaces the tag. Failures throw and abort the iteration.
- `` !?`<shell cmd>|||<fallback>` `` — try-shell. Same as `!` but stderr is suppressed and a non-zero exit returns the literal fallback. Prefer this for cross-platform safety.
- `` @spill[?]:<name>=`<shell cmd>[|||<fallback>]` `` — run `<cmd>` and write its **stdout to a file** `<name>` in the per-stage spill dir (`.otto-tmp/spill-…/`), substituting the workspace-relative path into the prompt for the agent to `Read`. The `?` form suppresses stderr and writes `<fallback>` on non-zero exit; `<name>` must be a plain filename (no path separators, no `..`). Use for large outputs — `review.md` spills the full HEAD patch, `ghafk.md` the full issue bodies.
- `@include:<rel-or-abs-path>` — inline a file (Node `readFileSync`). Path resolved against the template's own directory when relative. No shell. Use for bundled playbooks.
- `{{ INPUTS }}` — replaced with the `inputs` field passed into `runLoop`.

### Change feedback loops or task priority

The agent playbooks are self-contained: `prompt.md` (plan/PRD source + progress recording, for `otto-afk`) and `ghprompt.md` (issue triage + close/comment, for `otto-ghafk`). Each carries its own task-priority ladder, feedback loops, commit rules, and final rules. `afk.md` / `ghafk.md` each `@include` their respective playbook. Edit the playbook to change a loop's behavior.

---

## Source map

| File / dir                                    | Purpose                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/cli/bin/otto-afk.js` / `otto-ghafk.js`  | Bin entry points (`@phamvuhoang/otto`).                                       |
| `apps/cli/scripts/afk.sh` / `ghafk.sh`        | Optional shims; fall back to `npx @phamvuhoang/otto`. Shipped in the tarball. |
| `packages/core/src/main.ts` / `gh-main.ts`    | Export `runAfk(argv)` / `runGhAfk(argv)`.                                     |
| `packages/core/src/run-bin.ts`                | `runBin`: parse flags, resolve dirs, dispatch to `runLoop` / `runWatch`.      |
| `packages/core/src/loop.ts`                   | Iteration driver. Runs the stage chain; first stage is the gate.              |
| `packages/core/src/render.ts`                 | Template renderer (`@include` / `@spill` / `!?` / `!` / `{{ INPUTS }}`).      |
| `packages/core/src/runner.ts`                 | Native-sandbox runner: spawn `claude` + NDJSON stream + sandbox settings.     |
| `packages/core/src/stages.ts`                 | Stage registry — `implementer`, `ghafkImplementer`, `reviewer`.               |
| `packages/core/src/panel.ts`                  | `--review-panel`: lenses → adversarial verify → synth.                        |
| `packages/core/src/branch.ts` / `state.ts`    | Branch strategy + `.otto/config.json`; resume state (`.otto/state.json`).     |
| `packages/core/src/cli-help.ts`               | Flag parsing; `--help` / `--version` / `--print-config` output.               |
| `packages/core/src/retry.ts` / `keepalive.ts` | Per-stage retry/backoff; OS wake-lock.                                        |
| `packages/core/src/detach.ts` / `notify.ts`   | `--detach` fork-and-exit; `--notify` toast + bell.                            |
| `packages/core/templates/*.md`                | Stage templates + agent playbooks (ship in the core tarball).                 |

Deeper runtime data-flow lives in [ARCHITECTURE.md](./ARCHITECTURE.md).
