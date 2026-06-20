<h1 align="center">Otto</h1>

<p align="center">
  <strong>An autonomous agent harness for Claude Code — it ships while you're AFK.</strong><br>
  Hand Otto a plan, a PRD, or a backlog of GitHub/Linear issues — it implements, reviews, and commits, iteration after iteration, until the work is done.<br>
  Every run is sandboxed, budgeted, governed, and evaluable, and leaves a git-tracked evidence trail you can inspect, compare, and trust.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@phamvuhoang/otto"><img src="https://img.shields.io/npm/v/@phamvuhoang/otto?label=%40phamvuhoang%2Fotto" alt="@phamvuhoang/otto on npm"></a>
  <a href="https://www.npmjs.com/package/@phamvuhoang/otto-core"><img src="https://img.shields.io/npm/v/@phamvuhoang/otto-core?label=%40phamvuhoang%2Fotto-core" alt="@phamvuhoang/otto-core on npm"></a>
  <a href="https://github.com/phamvuhoang/otto/actions/workflows/ci.yml"><img src="https://github.com/phamvuhoang/otto/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-otto">Why Otto</a> ·
  <a href="#use-cases">Use cases</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#documentation">Docs</a>
</p>

---

Otto drives the [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI (or [Codex](https://github.com/openai/codex) via `--agent codex`) against a target repository in an iterating **implement → review** pipeline, running the agent directly on the host. It remembers what it learns, thinks before it codes, reviews its own work on a budget, and survives rate limits and restarts. Docker is not required.

**Built as a real agent harness, not a `while`-loop:** native-OS sandboxing, per-run cost budgets, a git-tracked **evidence bundle** per run, a CI-runnable **eval/benchmark** harness, governed memory, a repo-local **safety policy** with prompt-injection taint-fencing, adaptive compute routing, reusable **skills**, and an opt-in, secrecy-filtered **public journal** (build-in-public to Threads, off by default) — all driven from the CLI and importable as a library ([`@phamvuhoang/otto-core`](./packages/core)).

> ⚠️ **Security:** Otto runs Claude with `--permission-mode bypassPermissions`. The default `OTTO_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine writes to the workspace; `OTTO_RUNNER=host` runs unsandboxed. Point it only at repositories, plans, and issues you trust — see **[SECURITY.md](./SECURITY.md)**.

<p align="center">
  <img src="./docs/otto-stack.svg" alt="The Otto AFK stack: CLI and template layers feed a native-sandbox runner; the runtime loops gate → implement → review with run modes, a git-tracked learning loop, and an optional review panel." width="900">
</p>

---

## Quick start

```bash
# 1. Authenticate Claude Code on the host (one-off)
claude /login

# 2. Install the CLI globally
npm i -g @phamvuhoang/otto

# 3. From any git repo, hand Otto a plan + PRD and let it run
otto-afk "./docs/plans/feature.md ./docs/prd/feature.md" 10
```

That's it. Otto renders its prompt, implements one task, reviews the diff, commits, and repeats — up to 10 iterations or until it emits `<promise>NO MORE TASKS</promise>`. Want the unattended overnight version?

```bash
otto-afk --detach --notify "./docs/plans/feature.md" 50   # fork to background, toast when done
```

New to it? The **[QUICKSTART](./QUICKSTART.md)** walks zero-to-first-loop. No GitHub needed for `otto-afk`; `otto-ghafk` adds a one-time `gh auth login`.

---

## Why Otto

A naïve harness just loops `claude` until the iteration count runs out. Otto is the loop **plus the harness around it** — the parts that make an unattended run safe, affordable, and trustworthy:

| Concern         | A bare `while` loop around `claude` | **Otto**                                                                            |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| When to stop    | a fixed count, or never             | senses completion (`NO MORE TASKS`); early-stops on stalled progress                |
| Rate limits     | the loop dies                       | waits out the reset and resumes the same iteration; optional provider auto-switch   |
| Crash / restart | redoes everything                   | resumes from `.otto/state.json`; never redoes committed work                        |
| Code review     | none                                | self-review + an adversarial lens panel; only confirmed fixes land                  |
| Cost            | blind                               | per-run `--budget` ceiling, pacing, and token accounting                            |
| Memory          | none                                | git-tracked, governed learnings injected into every prompt                          |
| Safety          | full blast radius                   | native-OS sandbox + repo-local `.otto/policy.json` + prompt-injection taint-fencing |
| Observability   | terminal scrollback                 | an evidence bundle per run you can `inspect`, `compare`, and benchmark              |
| Compute spend   | same review depth always            | adaptive routing by change risk                                                     |
| Reuse           | copy-pasted prompts                 | validated, retrievable skills                                                        |

The rest of this section is the detail behind each row:

- 🧠 **It remembers.** Otto keeps a git-tracked `.otto/LEARNINGS.md` in your repo and injects it into every prompt. As it works it appends durable, reusable knowledge — conventions, gotchas, decisions _and their why_, dead ends — so each iteration starts smarter. The file rides in the work commit; delete it to reset Otto's memory.
- 📐 **It thinks before it codes.** Every iteration runs an adaptive **brainstorm → spec → plan → TDD** workflow. Hand it a crisp plan and it implements directly; hand it a vague one and it plays both sides of a brainstorm — generating clarifying questions, answering each with the most reasonable repo-grounded default, recording assumptions to `.otto/specs/`, then implementing test-first. Autonomously: it records its reasoning and proceeds rather than stopping to ask.
- 🔎 **It reviews itself, on a budget.** Past the single reviewer, an opt-in **review panel** runs read-only `correctness` / `security` / `tests` lenses, then an adversarial verifier that tries to _refute_ each finding (rejecting when unsure) before a single `fix(review):` commit lands only the confirmed defects. Cap spend with `--budget`, pace with `--cooldown`.
- 🎚️ **It can spend compute by risk.** Opt-in `--adaptive-router` routes each iteration's review depth by the risk of its change — single reviewer for a docs tweak, a lens subset for a narrow code change, the full panel for a security-sensitive or cross-module one — and stops a run early once it stops producing a meaningful diff. Off by default; pure, deterministic routing.
- 📊 **It can show token usage.** `--token-mode measure` prints per-stage and run-total input/output/cache token counts from Claude's `result` event. `--token-mode reduce` also applies conservative render-time prompt compaction; default `off` preserves current output and prompts.
- 🔁 **It survives the night.** Holds an OS wake-lock, retries transient failures with backoff, waits out Claude rate limits and resumes the same iteration, and persists `.otto/state.json` so a restart picks up where it left off — never redoing committed work.
- 🧾 **It leaves a paper trail.** Every run writes a durable **evidence bundle** to `.otto/runs/<run-id>/` — a manifest (inputs, runtime, iteration count, token/cost totals, exit reason, next action) plus one record per stage. `otto-inspect [latest]` renders it into a compact "what happened and why did Otto stop?" report, so you review the outcome instead of replaying `.otto-tmp/logs`.
- 🗃️ **Its memory is governed, not a growing blob.** Underneath the flat `LEARNINGS.md`, Otto can keep structured memory records as one git-tracked JSON file each under `.otto/memory/<id>.json` — every record carrying provenance (source run, task key), scope (which files/modules it applies to), confidence, trust level, and a freshness policy (expiry / revalidate). Newer records supersede older ones. `otto-memory audit` reports stale, conflicting, and frequently-used entries _before_ they influence a run, and `otto-memory project` renders only the **active** records back into a bounded `LEARNINGS.md` — so prompt size from memory stays explainable instead of contaminating unrelated runs with stale assumptions.
- 🛡️ **It governs what an unattended run may do.** A git-tracked `.otto/policy.json` declares repo-local safety rules — blocked commands, allowed write roots / network domains, secret patterns, high-risk globs, approval-required actions. Otto evaluates every host-shell / `@spill` command against the deny-list at the render boundary: a blocked command is _skipped_ — never executed — and recorded as a `blocked` safety event in the run's evidence bundle. Untrusted inputs it ingests (issue bodies, comments, external review docs) are fenced in a labelled `<untrusted>` block carrying a do-not-obey warning, so prompt-injection text can't pose as instructions. **The default empty policy restricts nothing**, so trusted local workflows are unchanged — a repo opts into governance by populating the file.
- 🛠️ **It gives you an operator view.** A CLI-first cockpit over the evidence bundles: `otto-runs list` for a one-row-per-run summary (status, iterations, cost, elapsed), `otto-inspect [latest]` for one run's report, `otto-explain [latest]` to re-render any run in plain language a non-engineer can verify, `otto-tail [latest]` to attach to a running loop and watch a live status tree (prints the done card once it finalizes), and `otto-eval compare <run-a> <run-b>` to A/B two past runs side-by-side **without re-paying for a run**. `--explain-routing` prints the adaptive router's per-iteration reasoning (change class, risk, chosen review depth) so a routing decision is never a black box. The in-run console is quiet by default (one terse line per meaningful action — edits, commits, test results, errors); `--verbose` restores the full firehose.
- 🧩 **It can turn repeated workflows into skills.** Stable, repeated procedures (release flow, test bootstrap, a migration pattern) can be promoted into git-tracked `.otto/skills/<name>/` packages — instructions + metadata + constraints + a last-validated run. `otto-skills candidates` suggests them from runs that succeeded the same way twice; `otto-skills why <changed-files>` shows which skills retrieval would pick and **why** (by capability, touched files, and change risk). A skill must be **validated before it is eligible**, and stale skills are flagged rather than reapplied.

Beyond the build loop, two read/repair modes reuse all of the above:

- 🔍 **`--verify`** — a read-only pass that reconciles a plan against git, runs the suites, and writes a DONE/GAP/DEFERRED report. Changes nothing.
- 🩹 **`--apply-review <doc>`** — consumes an external code-review document and fixes its actionable findings one per iteration, tracking deferred ones in the task-local `.otto/tasks/<task-key>/followups.md`.

---

## Use cases

Recipes grouped by what you're trying to do. The trailing number on the loop bins is the **max iteration count**; a run also stops early when the agent emits `<promise>NO MORE TASKS</promise>`.

### 1. Ship work autonomously

```bash
# Implement a plan + PRD, up to 10 iterations
otto-afk "./docs/plans/feature.md ./docs/prd/feature.md" 10

# Overnight, unattended: fork to background, hold a wake-lock, toast on finish/wedge
otto-afk --detach --notify "./docs/plans/inventory.md ./docs/prd/inventory.md" 50

# Burn down a GitHub backlog — one issue per iteration
otto-ghafk 10
otto-ghafk --issue 42 5                         # just issue #42, then stop
otto-ghafk --issue 42 --include-sub-issues 20   # an epic and its sub-issues

# Burn down a Linear backlog (label `otto`); --issue ENG-123 scopes to one
otto-linear-auth login                          # paste a Linear API key, once
otto-linear-afk 10
```

### 2. Operate & inspect the harness

```bash
# List recent runs at a glance: status, iterations, cost, elapsed (newest first)
otto-runs list

# Render one run's evidence bundle — "what happened and why did Otto stop?"
otto-inspect latest
otto-inspect 2026-06-20T05-53-11-000Z-12345     # a specific run id

# Re-render any past run in plain language for a non-engineer to verify
otto-explain latest
otto-explain 2026-06-20T05-53-11-000Z-12345     # a specific run id

# Attach to a running loop — polls the evidence bundle and prints a live tree;
# switches to the done card once the run finalizes (note: otto-watch is the
# separate ghafk/linear daemon that polls for labelled issues)
otto-tail                                        # attach to the latest run
otto-tail 2026-06-20T05-53-11-000Z-12345        # attach to a specific run id

# A/B two recorded runs side-by-side — FREE, no model call
otto-eval compare latest 2026-06-19T22-10-00-000Z-9876

# See exactly what will resolve (config + preflight) before any paid run
otto-afk --print-config

# Console output: by default Otto prints one terse line per meaningful action
# (file edits, git commits, test results, errors). Use --verbose to restore the
# full in-run firehose from all agent events.
otto-afk --verbose "my plan" 10
```

### 3. Evaluate & benchmark harness quality

```bash
# Replay the eval fixtures across configs and score each run (paid; never CI)
otto-eval benchmarks/suite.json benchmarks/configs.json --iterations 3

# Compare two past runs' trajectories — succeeded / cost / tokens / elapsed /
# safety events / skills used — without re-running anything
otto-eval compare <run-a> <run-b>

# Measure real token usage (in/out/cache, per stage + run total) without changing prompts
otto-afk --token-mode measure "./docs/plans/feature.md" 5
```

### 4. Control cost & compute

```bash
# Hard spend cap (halts at the ceiling) + pacing between iterations
otto-afk --budget 5 --cooldown 2000 "./docs/plans/spike.md" 20

# Higher-confidence review: correctness/security/tests lenses → adversarial verify
# → one consolidated fix(review): commit of only the confirmed defects
otto-afk --review-panel "./docs/plans/feature.md" 30

# Spend review compute by risk: single reviewer for docs, full panel for security —
# and print WHY each iteration routed the way it did
otto-afk --adaptive-router --explain-routing "./docs/plans/feature.md" 10

# Conservative render-time prompt compaction + token reporting
otto-afk --token-mode reduce "./docs/plans/feature.md" 5
```

### 5. Govern memory, safety & skills

```bash
# Governed memory: audit stale / conflicting / frequently-used records before they
# influence a run, then project the ACTIVE ones back into a bounded LEARNINGS.md
otto-memory audit
otto-memory project > .otto/LEARNINGS.md

# Safety policy: a repo opts into governance by populating .otto/policy.json
# (blocked commands, allowed write roots / network domains, secret patterns…).
# Blocked host commands are skipped and recorded as a safety event in the bundle.

# Skills: promote repeated successful workflows into validated, reusable procedures
otto-skills candidates                          # workflows that succeeded the same way >= 2x
otto-skills why packages/core/src/eval.ts       # which skills retrieval would pick, and why
otto-skills list                                # inventory + validated/unvalidated/stale status
```

### 6. Verify & repair (read-only / surgical)

```bash
# Did the plan actually land? Read-only DONE/GAP/DEFERRED report; changes nothing
otto-afk --verify "./docs/plans/feature.md ./docs/prd/feature.md"

# Consume an external code review and fix its actionable findings, one per iteration
otto-afk --apply-review ./code-review.md 20
```

### 7. Multi-provider, scope & daemon

```bash
# Run with Codex instead of Claude (after `codex login` / CODEX_API_KEY / OPENAI_API_KEY)
otto-afk --agent codex --print-config
OTTO_AGENT=codex otto-ghafk 5

# Start on Claude, auto-switch to Codex on a rate limit instead of waiting
otto-afk --fallback-agent codex --auto-switch-on-limit "./docs/plans/feature.md" 20

# Drive a different repo and pin the model
OTTO_WORKSPACE=~/code/other-repo OTTO_MODEL=claude-opus-4-8 otto-afk "./docs/plans/feature.md" 10

# Daemon: poll for newly-labelled issues and pick them up as they arrive
otto-ghafk --watch --watch-interval 300 5
otto-ghafk --repo owner/name --watch 5          # scope the daemon to one repo
```

Full flag reference and more recipes: **[docs/CLI.md](./docs/CLI.md)**.

---

## How it works

Otto ships as two npm packages:

- **[`@phamvuhoang/otto`](./apps/cli)** — the CLI: `otto-afk` (plan/PRD loop), `otto-ghafk` (GitHub-issue loop), and `otto-linear-afk` (Linear-issue loop, with the `otto-linear` helper + `otto-linear-auth` credential tool). The read-only operator bins: `otto-inspect` renders one run's evidence bundle, `otto-explain` re-renders any run in plain language for a non-engineer, `otto-runs` lists recent runs, `otto-tail` attaches to a running loop for a live status tree, `otto-eval compare` A/Bs two of them (and `otto-eval` benchmarks harness quality across configs — the [eval suite](./benchmarks)), `otto-memory` audits the governed memory records, and `otto-skills` inventories repo-local skill packages.
- **[`@phamvuhoang/otto-core`](./packages/core)** — the library: iteration loop, native-sandbox runner, template renderer, stage registry. Importable from any Node project.

Each iteration runs a **stage chain**: a **gate** stage (implement / verify / apply-review, depending on the bin and flags) followed by a **reviewer**. Before each stage, Otto renders a prompt template — expanding `@include`, `@spill`, `` !?`cmd` ``, `` !`cmd` ``, and `{{ INPUTS }}` tags — and injects the workspace's `.otto/LEARNINGS.md`. If the gate emits the sentinel `<promise>NO MORE TASKS</promise>`, the loop exits before the reviewer runs.

The [architecture diagram](#otto) above maps the full stack: CLI + template layers → native-sandbox runner → the loop runtime (run modes, learning loop, review panel) → scratch/observability/safety → build & release. The runtime internals are documented in **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

---

## Configuration

Otto is configured by flags and environment variables. The essentials:

| Variable          | Default         | Purpose                                                                                 |
| ----------------- | --------------- | --------------------------------------------------------------------------------------- |
| `OTTO_WORKSPACE`  | `cwd`           | Host repo the selected agent runs against; also where `.otto-tmp/` is written.          |
| `OTTO_RUNNER`     | `sandbox`       | `sandbox` confines writes to the workspace; `host` runs the selected agent unsandboxed. |
| `OTTO_MODEL`      | _(CLI default)_ | Pin the active runtime's model (`--model` pass-through).                                |
| `OTTO_TOKEN_MODE` | `off`           | `off`, `measure`, or `reduce`; overridden by `--token-mode`.                            |

### How to set config values

Every value resolves in a fixed precedence order — **CLI flag → environment variable → `.otto/config.json` → built-in default** — so a flag always wins for a single run, an env var sets a per-shell default, and the config file persists a choice for a repo. Pick the mechanism by how long the choice should stick:

```bash
# 1. Per-run — a flag, highest precedence, affects only this invocation
otto-afk --token-mode measure --budget 5 "<plan-and-prd>" 20

# 2. Per-shell — an env var, applies to every Otto run in this shell
export OTTO_RUNNER=host
export OTTO_MODEL=claude-opus-4-8
otto-afk "<plan-and-prd>" 20

# 2b. One-off env override, scoped to a single command
OTTO_TOKEN_MODE=reduce otto-afk "<plan-and-prd>" 20

# 3. Persistent — add the export lines to ~/.zshrc / ~/.bashrc for every new shell
```

Branch settings (`branchStrategy`, `branchPrefix`, `branchConvention`) can also be **persisted per-repo** in `<workspace>/.otto/config.json`. Running `otto-afk` in a TTY offers to write this file for you ("Remember for this repo?"); flags and env still override it.

Always confirm what actually resolved before a paid run:

```bash
otto-afk --print-config     # resolved config + a preflight check of run prerequisites, then exit
```

### What you can set

**Flags** (per-run; same set across all bins unless noted):

- **Agent runtime** — `--agent <claude|codex>` (default `claude`), `--fallback-agent <claude|codex>`, `--auto-switch-on-limit`
- **Loop & cost** — `--budget <usd>`, `--cooldown <ms>`, `--max-retries <N>`, `--max-wait <dur>`, `--token-mode <off|measure|reduce>`, `--review-panel`, `--adaptive-router`, `--fresh`
- **Process & UX** — `--detach`, `--log <path>`, `--notify`, `--no-keep-alive`, `--print-config`, `--help`, `--version`
- **Branch** — `--branch <current|branch|worktree>`, `--branch-convention <c>`, `--branch-prefix <p>`
- **Targeting** (`otto-ghafk` / `otto-linear-afk`) — `--watch`, `--watch-interval <sec>`, `--repo <owner/name>`, `--project <name>`, `--issue <ref>`, `--include-sub-issues` (otto-ghafk; with `--issue`)
- **Modes** (`otto-afk`) — `--verify`, `--apply-review <doc>`

**Environment variables** (per-shell defaults): `OTTO_WORKSPACE`, `OTTO_RUNNER`, `OTTO_SANDBOX_NET`, `OTTO_RESULT_GRACE_MS`, `OTTO_AGENT`, `OTTO_FALLBACK_AGENT`, `OTTO_AUTO_SWITCH_ON_LIMIT`, `OTTO_MODEL`, `OTTO_CLAUDE_MODEL`, `OTTO_CODEX_MODEL`, `OTTO_TOKEN_MODE`, `OTTO_REVIEW_LENSES`, `OTTO_MAX_WAIT`, `OTTO_WATCH_LABEL`, `OTTO_GITHUB_REPO(S)`, `OTTO_INCLUDE_SUB_ISSUES`, `OTTO_BRANCH`, `OTTO_BRANCH_PREFIX`, `OTTO_BRANCH_CONVENTION`, `OTTO_LINEAR_API_KEY` / `LINEAR_API_KEY`, `OTTO_LINEAR_LABEL`, `OTTO_LINEAR_TEAM`, `OTTO_LINEAR_PROJECT(S)`, `OTTO_LINEAR_DONE_STATE`, and `NO_COLOR` / `TERM=dumb`.

Full per-value descriptions, defaults, and runner/sandbox/branch details live in **[docs/CONFIG.md](./docs/CONFIG.md)**; every flag and mode is documented in **[docs/CLI.md](./docs/CLI.md)**.

---

## Installation

```bash
npm i -g @phamvuhoang/otto              # global — run otto-afk / otto-ghafk from anywhere
npm i -D @phamvuhoang/otto              # per-repo — ./node_modules/.bin/otto-afk
npx -y @phamvuhoang/otto otto-afk …     # no install — bootstrap on demand
```

Requires **Node 20+** and an authenticated agent runtime: **Claude Code** (`claude /login`) by default, or **Codex CLI** (`codex login`, `CODEX_API_KEY`, or `OPENAI_API_KEY`) when selected with `--agent codex`. `otto-ghafk` also needs authenticated **`gh`**; `otto-linear-afk` needs a Linear personal API key via `otto-linear-auth login`. See [docs/CONFIG.md → Prerequisites](./docs/CONFIG.md#prerequisites).

---

## Documentation

| Doc                                                                    | What's in it                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **[QUICKSTART.md](./QUICKSTART.md)**                                   | Zero-to-first-loop getting started.                                                                                                    |
| **[docs/CLI.md](./docs/CLI.md)**                                       | Every command, flag, and mode — start at [Choosing a mode](./docs/CLI.md#choosing-a-mode) (afk vs ghafk vs verify vs apply-review).    |
| **[docs/CONFIG.md](./docs/CONFIG.md)**                                 | Environment variables, runner/sandbox, branch strategy, setup.                                                                         |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**                     | Runtime internals and data flow for library extenders.                                                                                 |
| **[docs/MIGRATION.md](./docs/MIGRATION.md)**                           | Task-grouped `.otto/tasks/<task-key>/` layout, old→new path mapping, branch-convention namespace, and how to migrate an existing repo. |
| **[docs/quality-report-samples.md](./docs/quality-report-samples.md)** | Filled-in sample quality reports — what good verification output looks like per run mode.                                              |
| **[SECURITY.md](./SECURITY.md)**                                       | Threat model and the `bypassPermissions` blast-radius story.                                                                           |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)**                               | Dev loop, tests, adding a stage, release pipeline.                                                                                     |
| **[RELEASING.md](./RELEASING.md)**                                     | release-please flow, version policy, secrets, rollback.                                                                                |

---

## Contributing

Otto is a pnpm monorepo. The dev loop:

```bash
pnpm install
pnpm -r build        # compile packages/core/dist (only core builds)
pnpm -r typecheck
pnpm -r test         # core: vitest
pnpm test            # root: node --test over scripts/*.test.mjs
```

A husky pre-commit hook runs `lint-staged` (prettier) + typecheck. Releases are automated via [release-please](./RELEASING.md) — never hand-edit version fields. Full contributor guide in **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

---

## License

[MIT](./LICENSE) © Henry Pham.
