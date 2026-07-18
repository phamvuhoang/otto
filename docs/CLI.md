# CLI reference

Commands, flags, and modes for the two Otto bins. For environment variables, runner/sandbox behavior, and branch strategy see **[CONFIG.md](./CONFIG.md)**.

- [Choosing a mode](#choosing-a-mode)
- [Agent runtime (`--agent`)](#agent-runtime---agent)
- [`otto-afk` — plan/PRD loop](#otto-afk--planprd-loop)
- [`otto-ghafk` — GitHub-issue loop](#otto-ghafk--github-issue-loop)
- [`otto-linear-afk` — Linear-issue loop](#otto-linear-afk--linear-issue-loop)
- [Running AFK (detach, notify, retries, resume)](#running-afk)
- [Cost control, pacing & review panel](#cost-control-pacing--review-panel)
- [Worked recipes](#worked-recipes)
- [Verify & apply-review modes](#verify--apply-review-modes)
- [Watch mode](#watch-mode-otto-ghafk-only)
- [Single-issue mode](#single-issue-mode-otto-ghafk-only)
- [`otto-review` — automated pull-request code review](#otto-review--automated-pull-request-code-review)
- [Branch strategy](./CONFIG.md#branch-strategy)
- [Stopping a run](#stopping-a-run)
- [Troubleshooting](#troubleshooting)
- [Customizing the pipeline](#customizing-the-pipeline)
- [Source map](#source-map)

Every command also supports `--help` / `-h`, `--version` / `-V`, and `--print-config` (print the resolved config plus a preflight check of run prerequisites — the selected agent CLI/auth, git workspace, and provider CLIs such as `gh` — then exit). See [CONFIG.md → Prerequisites](./CONFIG.md#prerequisites) for the preflight block.

---

## Choosing a mode

Otto has one build loop with several entry points. They share the same resilience, sandbox, and reconcile-against-git behavior — they differ only in where the task comes from and what the **gate stage** (the first, sentinel-checked stage) does. Pick by where your work lives:

| Mode                                 | Input                                                           | Gate stage                 | When to use                                                                                               |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `otto-afk "<plan-and-prd>" <n>`      | A plan/PRD string (conventionally file paths) + iteration count | `implementer`              | Drive a local plan or PRD to completion, implementing one task per iteration.                             |
| `otto-ghafk <n>`                     | Open GitHub issues (no input arg)                               | `ghafk-implementer`        | Burn down a GitHub issue backlog, one issue per iteration. `--issue` targets one; `--watch` daemonizes.   |
| `otto-linear-afk <n>`                | Open Linear issues labelled `otto` (no input arg)               | `linear-implementer`       | Burn down a Linear backlog, one issue per iteration. `--issue ENG-123` targets one; `--watch` daemonizes. |
| `otto-afk --verify "<plan-and-prd>"` | A plan/PRD string (one-shot — no iteration count)               | `verifier` (read-only)     | Audit what actually landed: a DONE/GAP/DEFERRED report + suite run. Changes nothing, no reviewer stage.   |
| `otto-afk --apply-review <doc> <n>`  | An external code-review document + iteration count              | `apply-review-implementer` | Fix the actionable findings of an external review, one per iteration; deferred ones tracked in git.       |

`--verify` and `--apply-review` are `otto-afk` modes that swap the gate stage; they are mutually exclusive with each other and with `--issue` / `--watch`. `--review-panel` is orthogonal — it upgrades the **reviewer** stage in any of the above (it reviews Otto's _own_ diff), not the gate. Full per-mode detail follows.

---

## Agent runtime (`--agent`)

Every mode above runs against an **agent runtime** — the underlying agent CLI Otto drives. Otto is **Claude-first by default**; the runtime is provider-neutral so other CLIs can share the same loop, stages, templates, logs, budget, and watch behavior.

| Flag                         | Default  | What it does                                                                                                                            |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <runtime>`          | `claude` | Select the agent CLI runtime: `claude` or `codex`. Also via `OTTO_AGENT` or `.otto/config.json` `"agent"`.                              |
| `--fallback-agent <runtime>` | none     | Runtime to switch to when the active one hits a usage/rate limit: `claude` or `codex`. Also via `OTTO_FALLBACK_AGENT` / config.         |
| `--auto-switch-on-limit`     | off      | Switch to `--fallback-agent` on a limit instead of waiting it out. Also via `OTTO_AUTO_SWITCH_ON_LIMIT=1` / config `autoSwitchOnLimit`. |

**Selection precedence:** `--agent` flag → `OTTO_AGENT` env → `.otto/config.json` `"agent"` → default `claude`. A blank env/config value is skipped, not an error. An invalid value is **reported** by `--print-config` (exit 0) but **fatal** on a real run (exit 1) — so you always know the runtime before spending tokens.

```bash
# default — Claude Code
otto-afk "./docs/plans/feature.md" 10

# inspect Codex selection/preflight before any paid invocation
otto-afk --agent codex --print-config
OTTO_AGENT=codex otto-ghafk --print-config

# run with Codex
otto-afk --agent codex "./docs/plans/feature.md" 5
```

`--print-config` shows the resolved `runtime` (`<id> (<display name>)`), its `runtime source` (default/flag/env/config), the runtime-aware `model` line, and the `fallback` setting. The run banner echoes it (`otto-afk 0.x (core 0.x) · runtime: Claude Code`), each stage banner appends it (`iteration 2/10 · implementer · Claude Code`), the per-stage NDJSON log path carries a `-<id>` suffix (`…-iter2-implementer-claude.ndjson`), and the final summary prints `runtime: <id>` — or `runtime: claude -> codex (switched once: rate limit)` after an auto-switch.

**Runtime status today:** `claude` (Claude Code) is the default. `codex` (Codex CLI) is executable via `codex exec --json` and can be the primary runtime or the fallback runtime. Claude uses Otto's transient `--settings` sandbox file; Codex uses the global `--ask-for-approval never` flag plus `exec --ignore-user-config --sandbox workspace-write` when `OTTO_RUNNER=sandbox`, and `exec --ignore-user-config --sandbox danger-full-access` when `OTTO_RUNNER=host`. Codex auth is normally `codex login`; API-key runs can use `CODEX_API_KEY`, and Otto also accepts `OPENAI_API_KEY` by mapping it to `CODEX_API_KEY` for the Codex child process.

### Provider-specific model (`OTTO_CLAUDE_MODEL` / `OTTO_CODEX_MODEL`)

`OTTO_MODEL` pins the model for whichever runtime is active. To pin a different model per runtime when you switch between them, set the provider-specific override — it wins over `OTTO_MODEL` for that runtime only:

```bash
OTTO_CLAUDE_MODEL=<claude-model> OTTO_CODEX_MODEL=<codex-model> otto-afk --agent codex --print-config
```

Precedence per runtime: `OTTO_<RUNTIME>_MODEL` → `OTTO_MODEL` → the CLI's own default (an empty/whitespace override falls through). `--print-config`'s `model` line shows the resolved value and which env var supplied it.

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

## `otto-linear-afk` — Linear-issue loop

```bash
otto-linear-afk <iterations>
```

The Linear-backed sibling of `otto-ghafk`: same loop, same flags (`--budget`, `--cooldown`, `--review-panel`, `--detach`, `--notify`, `--issue`, `--watch`, `--print-config`), but it triages **Linear** issues over the GraphQL API instead of GitHub issues. No plan/PRD arg — context comes from open Linear issues labelled `otto`.

### Auth — `otto-linear-auth`

Linear access uses a **personal API key** (not OAuth, in v1). Create one in Linear → Settings → API → Personal API keys, then:

```bash
otto-linear-auth login          # paste the key on stdin; stored at ~/.config/otto/linear.json (0600)
otto-linear-auth status         # report whether a credential resolves, and from where
otto-linear-auth status --verify-live   # also call the API to confirm the key works
otto-linear-auth logout         # delete the stored credential file
```

The key is stored **outside any repo** at `~/.config/otto/linear.json` (`{ "type": "apiKey", "token": "…" }`, mode `0600`). Resolution precedence: `OTTO_LINEAR_API_KEY` → `LINEAR_API_KEY` → that file. `otto-linear-afk --print-config` adds a `linear auth` preflight row reporting the resolved source, or `run otto-linear-auth login` when absent.

### Issue selection

The loop lists **open** Linear issues carrying the label `otto` (override with `OTTO_LINEAR_LABEL`), optionally narrowed to one team with `OTTO_LINEAR_TEAM=ENG`. Full issue bodies + comments are spilled to `.otto-tmp/spill-…/issues.json` for the agent to `Read` before picking a task — the same lean-index-plus-spill shape as `otto-ghafk`.

### What happens per iteration

1. **Render template** `linearafk.md`: recent commits, the `otto-linear list` index, and the spilled `otto-linear dump` issue detail, plus `@include:linearprompt.md` (the playbook, which reuses the provider-agnostic `ghprompt-workflow.md` fragment).
2. **`linear-implementer` stage** (gate) — the agent picks one open labelled issue, implements it, commits, and completes the issue per repo convention (below).
3. **Sentinel check** — same as `otto-afk`.
4. **Reviewer stage** — same as `otto-afk`.

### The bundled `otto-linear` helper

Templates and the agent use a small bundled helper (parallel to `gh`) over the Linear GraphQL API:

```bash
otto-linear list --label otto --limit 50          # labelled open issues (identifier/title/state/url)
otto-linear dump --label otto --limit 50          # full issue detail as JSON (bodies + comments), for spilling
otto-linear view ENG-123                          # one issue's full detail as JSON
otto-linear comment ENG-123 --body-file <path>    # add a comment from a file
otto-linear done ENG-123                           # move to a completed workflow state
```

### Completion behaviour

Completion follows the target repo's convention (see its `.otto/LEARNINGS.md`):

- **PR repos** — `otto-linear comment ENG-123 --body-file <path>` with the branch/PR info, leaving the issue open (it closes when the PR merges).
- **Commit-to-branch repos** — `otto-linear done ENG-123` moves the issue to a completed state. The target state resolves via `OTTO_LINEAR_DONE_STATE` (by name, case-insensitive) first, else the first workflow state of `type = completed`. When that is ambiguous, `done` refuses to guess (exits non-zero) and the agent comments instead.

### Single-issue & watch modes

```bash
otto-linear-afk --issue ENG-123 5                                   # identifier
otto-linear-afk --issue https://linear.app/acme/issue/ENG-123/x 5   # full Linear URL
otto-linear-afk --watch --watch-interval 300 5                      # daemon, poll every 5 min
```

`--issue` accepts a Linear identifier (`ENG-123`, case-insensitive), an issue UUID, or a Linear issue URL — it scopes the loop to that one issue (gate stage `linear-issue-implementer`). `--watch` polls the **same** labelled set the implementer selects — `OTTO_LINEAR_LABEL` (+`OTTO_LINEAR_TEAM`), not `OTTO_WATCH_LABEL` — every `--watch-interval` seconds (default 300; Linear discourages aggressive polling). A missing/invalid key is reported distinctly (`run otto-linear-auth login`) from a transient poll failure, and the daemon keeps polling either way. `--issue` and `--watch` are mutually exclusive.

### Linear environment variables

| Variable                 | Default | What it does                                                                                                   |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `OTTO_LINEAR_API_KEY`    | _unset_ | Linear personal API key (highest-precedence source; then `LINEAR_API_KEY`, then `~/.config/otto/linear.json`). |
| `LINEAR_API_KEY`         | _unset_ | Fallback key source (precedence below `OTTO_LINEAR_API_KEY`).                                                  |
| `OTTO_LINEAR_LABEL`      | `otto`  | Label gating issue selection and `--watch` polling.                                                            |
| `OTTO_LINEAR_TEAM`       | _unset_ | Optional team-key narrowing (e.g. `ENG`).                                                                      |
| `OTTO_LINEAR_DONE_STATE` | _unset_ | Name of the workflow state `otto-linear done` moves an issue to; else the first `type = completed` state.      |

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
| `--max-wait <dur>`  | `6h`                                                   | Maximum time to wait out an agent rate-limit before halting. Accepts seconds (`90`) or a duration string (`90m`, `6h`). |
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

## Cost control, pacing, tokens & review panel

| Flag                                  | Default | What it does                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--budget <usd>`                      | off     | Stop the loop once cumulative Claude spend reaches this dollar amount (committed work is kept). Cost is printed per stage.                                                                                                                                                                                     |
| `--cooldown <ms>`                     | `0`     | Sleep between iterations; grows automatically (×2, capped) when the API signals throttling.                                                                                                                                                                                                                    |
| `--token-mode <off\|measure\|reduce>` | `off`   | `measure` prints actual input/output/cache token counts from Claude's `result` event. `reduce` also applies conservative render-time prompt compaction. `off` preserves current output and prompts.                                                                                                            |
| `--review-panel`                      | off     | Replace the single reviewer with a paced panel — read-only `correctness`/`security`/`tests` lenses → an adversarial verify pass (a skeptic refutes findings, defaulting to reject when uncertain) → one `fix(review):` commit that fixes only confirmed defects. Also enabled by setting `OTTO_REVIEW_LENSES`. |

```bash
# cap spend, pace iterations, and use the reviewer panel
otto-afk --budget 10 --cooldown 2000 --review-panel "<plan-and-prd>" 30

# inspect token usage without changing prompts
otto-afk --token-mode measure "<plan-and-prd>" 5

# opt into conservative prompt compaction plus token reporting
otto-afk --token-mode reduce "<plan-and-prd>" 5
```

Token counts are post-stage actuals, not preflight estimates. Cache-read tokens
are shown separately because provider cache reads are not the same as fresh
input tokens. Reduce mode never caches implementer/reviewer outputs or skips
required context; it only compacts rendered prompt whitespace in this MVP.

---

## Worked recipes

Three end-to-end maintainer workflows. Each is a copy-pasteable command block plus the end-state summary Otto prints when it finishes — the same `summarize()` line on every terminal path: `● Otto <reason> · N iterations · $cost`, followed by a `→ next:` hint telling you what to do next (and, when `.otto/review-followups.md` holds deferred findings, a `⚑ N deferred follow-ups` tally).

### Issue burn-down

Chew through a GitHub issue backlog, one issue per iteration, capped at 20 iterations and \$15 of spend. Otto reconciles against git each iteration, so already-closed work is never redone.

```bash
gh auth login                                  # once, if not already authed
OTTO_WORKSPACE=~/code/my-repo otto-ghafk --budget 15 20
```

When the backlog is empty the gate emits the sentinel and the run ends:

```
● Otto complete · 7 iterations · $4.82
  → next: review the diff, then open a PR
```

If the budget bites first, work already committed is kept and the hint tells you how to resume:

```
● Otto stopped (budget) · 12 iterations · $15.01
  → next: raise `--budget` and re-run to resume
```

To target a single issue instead of the whole backlog, swap in `--issue <n>` (see [Single-issue mode](#single-issue-mode-otto-ghafk-only)); to leave a daemon polling for new labelled issues, use `--watch` (see [Watch mode](#watch-mode-otto-ghafk-only)).

### External-review repair

Feed Otto a code-review document and have it fix the actionable findings one per iteration, each as its own `fix(review):` commit. Deferred findings are appended to the git-tracked `.otto/review-followups.md` and committed with the related fix.

```bash
your-reviewer > review.md                      # any tool/command that emits a findings doc
otto-afk --apply-review ./review.md --budget 8 25
```

The loop ends when no actionable findings remain. When the backlog still holds deferred findings, the summary tallies them so you know work remains:

```
● Otto complete · 9 iterations · $6.10
  → next: review the diff, then open a PR
  ⚑ 3 deferred follow-ups in .otto/review-followups.md
```

Then inspect the trail of everything it intentionally deferred:

```bash
git log --oneline --grep '^fix(review)'        # what landed
cat .otto/review-followups.md                  # what was deferred, and why
```

See [`--apply-review`](#--apply-review-doc) for the full triage rules.

### Overnight run

Drive a local plan/PRD to completion unattended. `--detach` forks the loop into the background; `--notify` raises an OS toast + bell when it finishes or fails; the wake-lock keeps the host awake; transient stage failures retry with backoff.

```bash
OTTO_WORKSPACE=~/code/my-repo otto-afk --detach --notify "./docs/plans/feature.md ./docs/prd/feature.md" 50
tail -f ~/code/my-repo/.otto-tmp/logs/detached-*.log   # follow from any shell
```

In the morning, the final log line tells you the outcome and the next action:

```
● Otto done · 31 iterations · $22.40
  → next: review the diff, then open a PR
```

If a stage hit an unrecoverable failure, the summary says so and points at the logs:

```
● Otto done with failures · 31 iterations · $22.40
  → next: inspect the failed stage logs under `.otto-tmp/logs`, then re-run
```

A re-run resumes from the saved `.otto/state.json` iteration; committed work is never redone (see [Resilience & resume](#resilience--resume)).

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

Runs the normal implement→review loop, but the gate triages an external review document. Per iteration it fixes **one** actionable finding (each `fix(review):`-committed, after reconciling against git so already-fixed items are skipped); deferred/follow-up findings are appended to the task-local `.otto/tasks/<task-key>/followups.md` (a git-tracked backlog, committed _with_ the related fix; the legacy global `.otto/review-followups.md` is still read as a fallback for one release — see **[MIGRATION.md](./MIGRATION.md)**); cosmetic ones are recorded as skipped. The loop ends when no actionable findings remain. `--review-panel`, `--budget`, and `--cooldown` all compose with it.

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

After the run, inspect the tracked backlog of everything it intentionally deferred (per task, or globbed across all tasks):

```bash
cat .otto/tasks/<task-key>/followups.md   # this task's deferrals
cat .otto/tasks/*/followups.md            # every task's deferrals
```

---

## Watch mode (`otto-ghafk` only)

Run as a daemon that idles, polls GitHub for labelled open issues, and runs the loop when work appears:

```bash
otto-ghafk --watch --watch-interval 300 5     # poll every 5 min, ≤5 iterations per trigger
```

The trigger label defaults to `otto` (`OTTO_WATCH_LABEL` to change it). Under `--watch`, `--budget` caps total spend across the whole session; `Ctrl+C` stops cleanly. Cannot be combined with `--issue`.

Each poll reports its state distinctly, so an idle daemon is never confused with a broken one:

- **`no open issues labelled otto — idle, next poll in 300s`** — the queue is empty; nothing is wrong, Otto is waiting for labelled work.
- **`gh not authenticated — run 'gh auth login' (label otto)`** — the poll failed because `gh` is not logged in; fix auth and it resumes on the next poll.
- **`gh issue poll failed (label otto) — <detail>`** — any other poll failure (network, `gh` missing), with the first line of `gh`'s error as `<detail>`.

It keeps polling in every case, so a transient failure or a fixed login recovers on its own.

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

### Sub-issue expansion (`--include-sub-issues`)

Parent "epic" issues often carry only a high-level description, with the real work living in their children. Add `--include-sub-issues` (or `OTTO_INCLUDE_SUB_ISSUES=1`) to expand a target issue into its open children and run the single-issue loop once per child:

```bash
otto-ghafk --issue 38 --include-sub-issues 5
```

How it resolves children:

- **Native GitHub sub-issues first** (`gh api repos/{owner}/{repo}/issues/<n>/sub_issues`, paginated).
- **Markdown task-list fallback** when the issue has no native sub-issues: it parses the parent body for task-list references (`- [ ] #N` / `- [x] #N`) **in document order**.
- The tree is walked **recursively, depth-first** (a child's own sub-issues are implemented before the child), only **open** issues are processed, and the **parent is skipped** (it is treated as a pure tracker). Cycles are guarded.

Each child is scoped exactly like a single-issue run (its own `<promise>NO MORE TASKS</promise>` gate and resume state). `<iterations>` is the per-child safety cap; `--budget` spans the **whole invocation** (the loop stops launching further children once the budget is exhausted). If the target has no children at all, it behaves as an ordinary single-issue run; if it has children but they are all closed, there is nothing to do.

`--include-sub-issues` is `otto-ghafk`-only and requires `--issue`.

---

## Operator commands

Read-only views over the evidence bundles under `.otto/runs/` (no model calls, never paid). All resolve the workspace from `OTTO_WORKSPACE` (default: cwd).

```bash
# One run's report: "what happened and why did Otto stop?". `latest` = most recent.
otto-inspect [<run-id>|latest]

# One row per run: id, bin, mode, status, iterations, cost, elapsed (newest first).
otto-runs list

# A/B two recorded runs side-by-side (succeeded / cost / tokens / elapsed / safety
# events / skills used), marking best/worst per directional signal. `latest` works.
otto-eval compare <run-a> <run-b>
```

### `--explain-routing`

With `--adaptive-router` on, `--explain-routing` (or `OTTO_EXPLAIN_ROUTING=1`) prints the router's per-iteration reasoning to stderr — the change **class** + risk **level**, the signals that drove it, the chosen review **depth** + **lenses**, and the progress decision (`continue` / stop / escalate) with its reason. Without `--adaptive-router` there is no routing decision to explain, so the flag is a no-op (it says so once).

```bash
otto-afk --adaptive-router --explain-routing "./docs/plans/feature.md" 10
```

### `otto-skills` — repo-local skill packages

A skill is a git-tracked directory package `.otto/skills/<name>/` — `skill.json` (capabilities, constraints, scope globs, validation provenance) + `instructions.md`. The bin is **read-only**: it never runs a skill's tests or applies a skill (the loop does not auto-apply skills).

```bash
otto-skills list                              # inventory + derived status (validated/unvalidated/stale)
otto-skills audit                             # how many are usable; which need (re)validation; which drifted
otto-skills why <changed-path>...             # which skills retrieval would select for these files, and why
otto-skills why --stage <stage> [--changed <path>...]  # which validated skills route to a live stage (P18), and why
otto-skills validate <skill> [--source <n>]   # run the compatibility + validation gate; persist the class
otto-skills candidates                        # workflows that succeeded the same way >= 2x — worth extracting
```

A skill is **eligible** for reuse only once a successful run has validated it (`validation.lastValidatedRun`) and it is within its `revalidateAfterDays` window; otherwise `otto-skills why` flags it `skip` with the reason. Retrieval ranks by declared capability, scope-glob match against the changed files, and the change's risk class (a skill whose constraints forbid that class is excluded).

**The compatibility + validation gate (`validate`).** Before an imported or repo-authored skill can shape a live run, it must clear a static gate: manifest/schema lint, frontmatter/capability extraction, a license/provenance check (`--source <name>` asserts the skill belongs to that source), and an **instruction-risk scan** (unsafe shell advice, secret handling, network use, interactive hard stops, unsupported-tool assumptions, and attempts to overrule repo policy). Each finding names the exact blocker and a remediation. The gate then derives a **compatibility class** — `afk-safe` (usable unattended), `interactive-only` (needs a human; `--plan` only), `stage-scoped` (valid only on the stages its capabilities imply, e.g. a `code-review` skill → review), or `blocked` (a policy/safety violation) — and runs small **behavior drills** (Superpowers planning/TDD must stay usable; a PM roadmap/PRD skill must scope to plan; a review skill must not overrule policy). The class, stages, check time, and a body checksum are persisted to `skill.json`'s `validation` block; `validate` exits non-zero on a blocking error or a failed drill. **Validation is separate from selection** — a validated skill is _eligible_, not auto-applied. If a skill's body later drifts from the validated checksum (e.g. an upstream re-sync), `otto-skills audit` flags it as needing revalidation before reuse.

**Runtime activation (`--use-skills`, P18).** Validation makes a skill _eligible_; activation actually injects it. Opt in per run with `--use-skills`, `OTTO_USE_SKILLS=1`, or `.otto/config.json` `"skills": { "enabled": true, "plan": true, "review": false, … }` (per-stage-family overrides). When active, each live stage routes the installed skills — only `afk-safe` (any stage) or `stage-scoped` skills whose stages match the running family, never `blocked`/`interactive-only`/drifted — ranks them by scope-glob match against the iteration's changed files, and appends a **bounded, attributed `<available-skills>` block** (capped per-stage char budget, source/ref/checksum labelled, with a standing note that repo policy + stage contracts outrank skills and conflicts must be reported). The selected skills are recorded as `skillsUsed[]` on each stage record and the run manifest, surfaced by `otto-inspect`, `otto-explain`, and `otto-eval`. Off by default: a run that does not opt in renders byte-for-byte as before. Preview the routing for a stage with `otto-skills why --stage <stage> [--changed <path>...]`.

### `otto-extensions` — curated extension profiles

Bundle the skill/tool/config primitives into one opinionated starting point for a common job, materialized as **normal, inspectable** `.otto/` config (not hidden behavior).

```bash
otto-extensions list                         # coding-superpowers | pm-planning | context-saver | security-review
otto-extensions init <profile> --dry-run     # preview every file it would write
otto-extensions init <profile>               # write sources.json / tools/*.json / config.json / policy.json
```

`init` registers pinned skill sources (still imported `unverified` — validate before use), writes tool adapters (still policy-scoped), deep-merges activation config, and union-merges policy (never relaxes an existing rule). It is idempotent and writes only files you could write by hand, so `git diff .otto/` shows exactly what changed and `git checkout .otto/` rolls it back. Full per-profile detail, the **compatibility matrix**, and update/lock/rollback guidance: **[EXTENSIONS.md](./EXTENSIONS.md)**.

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
- **Codex stalls before any assistant output** — Otto runs Codex with `exec --ignore-user-config` so personal Codex MCP/plugin config is not loaded into unattended stages. Older Otto versions can hang if a user MCP server blocks during Codex startup.

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

## `otto-review` — automated pull-request code review

```bash
otto-review --repo <owner/name> --pr <number|url> [flags]
otto-review --repo <owner/name> --watch [flags]
```

`otto-review` reviews an EXACT pull-request revision — the `base...head` diff GitHub reports, isolated in a disposable git worktree — and publishes only a report. It never edits, commits, or pushes source, and never calls `gh`/the network with a live credential from the review stage itself (see [Trust boundary](#trust-boundary) below). One-shot (`--pr`) reviews exactly one PR and exits; `--watch` polls the repo's open, non-draft pull requests carrying a label (default `otto-review`) and reviews each newly-eligible one, forever. Exactly one of `--pr` / `--watch` is required.

### Flags, environment, and config

| Flag                                | Env                         | `.otto/config.json` `pullRequestReview.` | Default                                    | What it does                                                                                                                    |
| ----------------------------------- | --------------------------- | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>`               | —                           | —                                        | _(required)_                               | The GitHub repository to review.                                                                                                |
| `--pr <n\|url>`                     | —                           | —                                        | _(exactly one of `--pr`/`--watch`)_        | A PR number or GitHub PR URL (one-shot mode).                                                                                   |
| `--watch`                           | —                           | —                                        | off                                        | Poll for eligible PRs instead of reviewing one (exactly one of `--pr`/`--watch`).                                               |
| `--watch-interval <sec>`            | —                           | —                                        | `300`                                      | Seconds between polls; only valid with `--watch`.                                                                               |
| `--label <name>`                    | `OTTO_REVIEW_LABEL`         | `label`                                  | `otto-review`                              | Label a PR must carry to be eligible.                                                                                           |
| `--review-skill <name>`             | `OTTO_REVIEW_SKILL`         | `skill`                                  | none (built-in `builtin:otto-code-review`) | Named repo skill (`.otto/skills/<name>/`) to apply instead of the built-in.                                                     |
| `--spec-issue <ref>`                | _(none — invocation-only)_  | _(none — invocation-only)_               | none                                       | Spec/context from a GitHub issue.                                                                                               |
| `--spec-file <path>`                | _(none — invocation-only)_  | _(none — invocation-only)_               | none                                       | Spec/context from a workspace file.                                                                                             |
| `--prompt <text>`                   | _(none — invocation-only)_  | _(none — invocation-only)_               | none                                       | Spec/context from a direct string.                                                                                              |
| `--output <mode>`                   | `OTTO_REVIEW_OUTPUT`        | `output`                                 | `text` one-shot, `comment` in `--watch`    | `text` \| `markdown` \| `comment`.                                                                                              |
| `--output-file <path>`              | —                           | —                                        | none                                       | Copy the Markdown output here too. Requires `--output markdown`.                                                                |
| `--github-review`                   | —                           | `githubReview`                           | off                                        | Additionally post one formal (native) GitHub PR review.                                                                         |
| `--agent <runtime>`                 | `OTTO_AGENT`                | `agent`                                  | `claude`                                   | Agent CLI runtime: `claude` \| `codex`.                                                                                         |
| `--fallback-agent <runtime>`        | `OTTO_FALLBACK_AGENT`       | —                                        | none                                       | Runtime to switch to on a usage/rate limit.                                                                                     |
| `--auto-switch-on-limit`            | `OTTO_AUTO_SWITCH_ON_LIMIT` | —                                        | off                                        | Switch to the fallback runtime automatically on a limit.                                                                        |
| `--model-routing`                   | —                           | —                                        | off                                        | Route each stage to a model tier by difficulty/change risk.                                                                     |
| `--token-mode <mode>`               | —                           | —                                        | `off`                                      | `off` \| `measure` \| `reduce`.                                                                                                 |
| `--context-compressor <mode>`       | `OTTO_CONTEXT_COMPRESSOR`   | —                                        | `off`                                      | `off` \| `headroom` — compresses the PR **body** only (never review-input; see [Evidence](#durable-evidence--input-artifacts)). |
| `--budget <usd>`                    | —                           | —                                        | none                                       | Stop when cumulative cost reaches this USD ceiling.                                                                             |
| `--cooldown <ms>`                   | —                           | —                                        | `0`                                        | Wait this many milliseconds between iterations.                                                                                 |
| `--max-retries <n>`                 | —                           | —                                        | (shared default)                           | Per-stage retry budget on transient failure.                                                                                    |
| `--detach`                          | —                           | —                                        | off                                        | Fork into a background process. Only valid with `--watch`.                                                                      |
| `--log <path>`                      | —                           | —                                        | none                                       | Override the detached log path. Only valid with `--detach`.                                                                     |
| `--notify`                          | —                           | —                                        | off                                        | OS notification + terminal bell on completion.                                                                                  |
| `--verbose`                         | —                           | —                                        | off                                        | Print the full in-run event firehose.                                                                                           |
| `--print-config`                    | —                           | —                                        | —                                          | Print the resolved config + a local-only preflight, then exit.                                                                  |
| `--help` / `-h`, `--version` / `-V` | —                           | —                                        | —                                          | Standard help/version.                                                                                                          |

Precedence for `--label`/`--review-skill`/`--output`: **flag → env → config → default**. `--repo`/`--pr`/`--watch` and the review-input trio are **invocation-only** — `--spec-issue`, `--spec-file`, and `--prompt` have **no environment variable or `.otto/config.json` equivalent at all**; they are resolved fresh from argv on every single run (and, in `--watch`, freshly on every poll), never persisted as a default.

`--print-config` performs **local probes only** — it never fetches a GitHub label/issue or calls a model. It reports the resolved config (redacting a `--prompt`'s text — only its character count, e.g. `direct (<N> chars)`, is ever shown), then labels the remote checks explicitly as **deferred**: `review label` and `review input` both print `deferred — checked/resolved on a real run`.

### Review input: `--spec-issue` / `--spec-file` / `--prompt`

At most one of `--spec-issue`, `--spec-file`, or `--prompt` may be given; passing more than one is a validation error before any run starts. All three are optional — the default (`--pr`/`--watch` with none of the three) reviews the diff alone.

- **`--spec-issue <ref>`** — a bare positive integer (`456`) or a same-repository issue URL `https://github.com/<owner>/<repo>/issues/<n>` whose `owner/repo` matches `--repo` case-insensitively. A cross-repository issue URL, a PR URL, a URL with a query string/fragment, or a non-GitHub host is rejected **before any GitHub call**.
- **`--spec-file <path>`** — a workspace-relative path to a `.txt`, `.md`, or `.markdown` file. Rejected before any read: an absolute path, `..` traversal, a symlink (checked via `lstat` before `realpath`), a real target that escapes the workspace, a non-regular file (directory/FIFO/etc.), an unsupported extension, invalid UTF-8, or an empty file.
- **`--prompt <text>`** — a direct string. Rejected when empty or whitespace-only. Never echoed anywhere — logs, `--print-config`, and every rendered stage variable carry only a **path** to the persisted artifact, never the text inline.

Every accepted input becomes an exact, deterministic snapshot — `kind`, canonical `source`, and verbatim `content` — fingerprinted with SHA-256 and written atomically to **`.otto/runs/<run-id>/review-input.md`** (provenance `kind`/`source`/`fingerprint`/`artifactPath` is rendered in every output; the raw `content` itself is rendered nowhere except that one artifact and the model's own read of it). The review-input artifact is retained **byte-for-byte and uncompressed** — `--context-compressor headroom` only ever compresses the PR body, never review-input.

In `--watch` mode the configured review input is **re-resolved fresh on every poll** — an edited issue, a changed workspace file, or updated prompt text yields a new fingerprint, which is new work; a resolution failure is treated as a poll failure (retried next interval), never a silently empty queue.

### One review per (head, input) — composite identity and reruns

Otto reviews each **composite identity** `(repository, pull request, head SHA, review-input fingerprint)` exactly once. A force-push (new head SHA) or a changed issue/file/prompt (new fingerprint) on the SAME head is a **new** composite review — unchanged content on an unchanged head is skipped with no re-analysis and no repeated remote write. State is durable, one JSON record per composite identity, gitignored under:

```
.otto/review-state/github/<owner>/<repo>/<pr>/<head-sha>/<fingerprint>.json
```

A transient publish failure (rate limit, network) is retried with a bounded exponential backoff (60s → 120s → 240s… capped at 15 minutes); a permanent failure (auth, validation, GitHub's self-approval refusal — see below) is terminal and never retried automatically.

### Review skill

By default every review runs the template-owned built-in contract `builtin:otto-code-review`. `--review-skill <name>` (or `OTTO_REVIEW_SKILL` / config `skill`) selects one repo skill from `.otto/skills/<name>/` instead — subject to the SAME governance ladder used elsewhere: the skill must exist, its status must be **`validated`**, and its static compatibility must be **`afk-safe`** or **`stage-scoped`** with `"review"` in its declared stages (a `blocked`/`interactive-only`/undeclared/checksum-drifted skill is rejected). An explicit `--review-skill` request that fails **never falls back to the built-in** — the run fails closed rather than silently substituting a different contract.

### Trust boundary

The lens and verifier stages run with `access: "read-only"` and `permissionMode: "plan"` — no edit, no commit, no push, no fix commit is ever produced. Before either stage runs, the child environment is stripped of `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`/`SSH_AUTH_SOCK`/`GIT_ASKPASS`/`SSH_ASKPASS`, `gh` is redirected to a harness-owned empty config directory, and git's own credential helper/ambient config is neutralized — so even a model that tried to shell out to `gh` or push over the network would have no GitHub credential or network reach available to it. Any mutation the model makes anyway — a tracked edit, a new untracked file, or a commit inside the isolated worktree — is detected and fails the run closed (`analysis-failed`, nothing published) rather than silently reverted or ignored. Every GitHub **write** (the summary comment, the formal review) is issued only by the harness's own publisher, never by the model.

### Idempotency, markers, and watch limitations

Every canonical review carries three stable Markdown-comment markers (never rendered inside a code fence, so GitHub still recognizes them):

- `<!-- otto-review:<owner>/<repo>#<pr> -->` — the per-PR summary marker.
- `<!-- otto-review-head:<head-sha> -->` — the exact reviewed revision.
- `<!-- otto-review-input:<fingerprint> -->` — the exact review-input fingerprint.
- `<!-- otto-review:<owner>/<repo>#<pr>@<head-sha>:<fingerprint> -->` — the composite formal-review idempotency key (used only by `--github-review`'s own review body).

The summary comment (`--output comment`) is created-or-updated **idempotently by marker**, not by any locally-remembered comment id: a restart that lost local state re-queries the PR's comments, finds the single comment it owns (authored by the viewer, carrying the marker), and updates that same comment instead of duplicating it. `--github-review` submits exactly one formal review per composite identity the same way. **GitHub refusing to let the bot approve its own pull request is a permanent (non-retryable) `publish-failed`** — it never spins in the retry backoff.

Immediately before every remote write the pipeline **re-queries the live PR**: a head that advanced during analysis is `superseded`, and a PR that went closed/merged, draft, or lost the required label is `cancelled` — either way, no comment and no formal review are ever posted for a stale revision.

`--watch`'s composite-identity state and advisory claim are **local to one workspace** — only run **one `--watch` daemon per workspace** against a given repository at a time. Two independent workspaces (e.g. two separate clones) polling the same repository do not share `.otto/review-state/` and are not coordinated with each other; run a single daemon per repository, in one workspace.

### Durable evidence & input artifacts

Every run leaves the same evidence bundle shape as the other bins, under `.otto/runs/<run-id>/`:

| Artifact                      | Contents                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `review-input.md`             | The exact, uncompressed review-input snapshot (provenance header + content).                |
| `pr.diff`                     | The exact `base...head` unified diff (byte-for-byte, including binary hunks).               |
| `analysis.json`               | The schema-validated confirmed/rejected findings, severity tally, and skill used.           |
| `review.md`                   | The canonical Markdown review (also the `--github-review` body, minus the per-run markers). |
| `report.md` / `manifest.json` | The standard harness report + evidence manifest.                                            |

Otto never edits a target repository's tracked `.gitignore` for its own scratch/state paths. Instead it resolves the repository's **local** `.git/info/exclude` (via `git rev-parse --git-path info/exclude`) and atomically appends `.otto-tmp/`, `.otto/runs/`, and `.otto/review-state/` there — a change that is per-clone, untracked, and never shows up in `git status` or a diff of the target repo.

---

## Source map

| File / dir                                                                                | Purpose                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/cli/bin/otto-afk.js` / `otto-ghafk.js`                                              | Bin entry points (`@phamvuhoang/otto`).                                              |
| `apps/cli/bin/otto-linear-afk.js` / `otto-linear.js` / `otto-linear-auth.js`              | Linear mode bins: the loop, the GraphQL helper, and the credential tool.             |
| `packages/core/src/linear-main.ts` / `linear-api.ts` / `linear-cli.ts` / `linear-auth.ts` | `runLinearAfk`; GraphQL ops + ref parsing; `otto-linear` helper; `otto-linear-auth`. |
| `apps/cli/scripts/afk.sh` / `ghafk.sh`                                                    | Optional shims; fall back to `npx @phamvuhoang/otto`. Shipped in the tarball.        |
| `packages/core/src/main.ts` / `gh-main.ts`                                                | Export `runAfk(argv)` / `runGhAfk(argv)`.                                            |
| `packages/core/src/run-bin.ts`                                                            | `runBin`: parse flags, resolve dirs, dispatch to `runLoop` / `runWatch`.             |
| `packages/core/src/loop.ts`                                                               | Iteration driver. Runs the stage chain; first stage is the gate.                     |
| `packages/core/src/render.ts`                                                             | Template renderer (`@include` / `@spill` / `!?` / `!` / `{{ INPUTS }}`).             |
| `packages/core/src/runner.ts`                                                             | Native-sandbox runner: spawn `claude` + NDJSON stream + sandbox settings.            |
| `packages/core/src/stages.ts`                                                             | Stage registry — `implementer`, `ghafkImplementer`, `linearImplementer`, `reviewer`. |
| `packages/core/src/panel.ts`                                                              | `--review-panel`: lenses → adversarial verify → synth.                               |
| `packages/core/src/branch.ts` / `state.ts`                                                | Branch strategy + `.otto/config.json`; resume state (`.otto/state.json`).            |
| `packages/core/src/cli-help.ts`                                                           | Flag parsing; `--help` / `--version` / `--print-config` output.                      |
| `packages/core/src/retry.ts` / `keepalive.ts`                                             | Per-stage retry/backoff; OS wake-lock.                                               |
| `packages/core/src/detach.ts` / `notify.ts`                                               | `--detach` fork-and-exit; `--notify` toast + bell.                                   |
| `packages/core/templates/*.md`                                                            | Stage templates + agent playbooks (ship in the core tarball).                        |

Deeper runtime data-flow lives in [ARCHITECTURE.md](./ARCHITECTURE.md).
