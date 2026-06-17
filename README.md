<h1 align="center">Otto</h1>

<p align="center">
  <strong>Autonomous Claude Code loops that ship while you're AFK.</strong><br>
  Hand Otto a plan, a PRD, or a backlog of GitHub issues — it implements, reviews, and commits, iteration after iteration, until the work is done.
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
  <a href="#examples">Examples</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#documentation">Docs</a>
</p>

---

Otto drives the [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target repository in an iterating **implement → review** pipeline, running `claude` directly on the host. It remembers what it learns, thinks before it codes, reviews its own work on a budget, and survives rate limits and restarts. Docker is not required.

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

More than a `while`-loop around `claude`:

- 🧠 **It remembers.** Otto keeps a git-tracked `.otto/LEARNINGS.md` in your repo and injects it into every prompt. As it works it appends durable, reusable knowledge — conventions, gotchas, decisions _and their why_, dead ends — so each iteration starts smarter. The file rides in the work commit; delete it to reset Otto's memory.
- 📐 **It thinks before it codes.** Every iteration runs an adaptive **brainstorm → spec → plan → TDD** workflow. Hand it a crisp plan and it implements directly; hand it a vague one and it plays both sides of a brainstorm — generating clarifying questions, answering each with the most reasonable repo-grounded default, recording assumptions to `.otto/specs/`, then implementing test-first. Autonomously: it records its reasoning and proceeds rather than stopping to ask.
- 🔎 **It reviews itself, on a budget.** Past the single reviewer, an opt-in **review panel** runs read-only `correctness` / `security` / `tests` lenses, then an adversarial verifier that tries to _refute_ each finding (rejecting when unsure) before a single `fix(review):` commit lands only the confirmed defects. Cap spend with `--budget`, pace with `--cooldown`.
- 🔁 **It survives the night.** Holds an OS wake-lock, retries transient failures with backoff, waits out Claude rate limits and resumes the same iteration, and persists `.otto/state.json` so a restart picks up where it left off — never redoing committed work.

Beyond the build loop, two read/repair modes reuse all of the above:

- 🔍 **`--verify`** — a read-only pass that reconciles a plan against git, runs the suites, and writes a DONE/GAP/DEFERRED report. Changes nothing.
- 🩹 **`--apply-review <doc>`** — consumes an external code-review document and fixes its actionable findings one per iteration, tracking deferred ones in the task-local `.otto/tasks/<task-key>/followups.md`.

---

## Examples

```bash
# Ship a plan/PRD while you sleep — background, wake-lock, toast on finish/wedge
otto-afk --detach --notify "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 50

# Burn down your GitHub issue backlog — one issue per iteration
otto-ghafk 10

# Fix one specific issue and stop
otto-ghafk --issue 42 5

# Burn down a Linear backlog (label `otto`); --issue ENG-123 scopes to one
otto-linear-auth login                         # paste a Linear personal API key, once
otto-linear-afk 10

# Keep spend on a leash for an exploratory spike
otto-afk --budget 5 "./docs/plans/spike.md" 20

# Higher-confidence review: multi-lens panel → one consolidated fix(review): commit
otto-afk --review-panel "./docs/plans/feature.md" 30

# Read-only audit: did the plan actually land? (writes .otto-tmp/verify-report.md)
otto-afk --verify "./docs/plans/feature.md ./docs/prd/feature.md"

# Apply an external code review, fixing actionable findings one per iteration
otto-afk --apply-review ./code-review.md 20

# Run as a daemon that wakes on newly-labelled issues
otto-ghafk --watch --watch-interval 300 5

# Drive a repo other than the current directory; pin the model
OTTO_WORKSPACE=~/code/other-repo OTTO_MODEL=opus otto-afk "./docs/plans/feature.md" 10
```

Full flag reference and more verify / apply-review recipes: **[docs/CLI.md](./docs/CLI.md)**.

---

## How it works

Otto ships as two npm packages:

- **[`@phamvuhoang/otto`](./apps/cli)** — the CLI: `otto-afk` (plan/PRD loop), `otto-ghafk` (GitHub-issue loop), and `otto-linear-afk` (Linear-issue loop, with the `otto-linear` helper + `otto-linear-auth` credential tool).
- **[`@phamvuhoang/otto-core`](./packages/core)** — the library: iteration loop, native-sandbox runner, template renderer, stage registry. Importable from any Node project.

Each iteration runs a **stage chain**: a **gate** stage (implement / verify / apply-review, depending on the bin and flags) followed by a **reviewer**. Before each stage, Otto renders a prompt template — expanding `@include`, `@spill`, `` !?`cmd` ``, `` !`cmd` ``, and `{{ INPUTS }}` tags — and injects the workspace's `.otto/LEARNINGS.md`. If the gate emits the sentinel `<promise>NO MORE TASKS</promise>`, the loop exits before the reviewer runs.

The [architecture diagram](#otto) above maps the full stack: CLI + template layers → native-sandbox runner → the loop runtime (run modes, learning loop, review panel) → scratch/observability/safety → build & release. The runtime internals are documented in **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

---

## Configuration

Otto is configured by flags and environment variables. The essentials:

| Variable         | Default         | Purpose                                                              |
| ---------------- | --------------- | -------------------------------------------------------------------- |
| `OTTO_WORKSPACE` | `cwd`           | Host repo Claude runs against; also where `.otto-tmp/` is written.   |
| `OTTO_RUNNER`    | `sandbox`       | `sandbox` confines writes to the workspace; `host` runs unsandboxed. |
| `OTTO_MODEL`     | _(CLI default)_ | Pin the Claude model (`--model` pass-through).                       |

```bash
otto-afk --print-config     # resolved config + a preflight check of run prerequisites, then exit
```

Full environment reference, runner/sandbox details, and branch strategy: **[docs/CONFIG.md](./docs/CONFIG.md)**.

---

## Installation

```bash
npm i -g @phamvuhoang/otto              # global — run otto-afk / otto-ghafk from anywhere
npm i -D @phamvuhoang/otto              # per-repo — ./node_modules/.bin/otto-afk
npx -y @phamvuhoang/otto otto-afk …     # no install — bootstrap on demand
```

Requires **Node 20+**, an authenticated **Claude Code** (`claude /login`), and — for `otto-ghafk` — an authenticated **`gh`** (for `otto-linear-afk`, a Linear personal API key via `otto-linear-auth login`). See [docs/CONFIG.md → Prerequisites](./docs/CONFIG.md#prerequisites).

---

## Documentation

| Doc                                                | What's in it                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **[QUICKSTART.md](./QUICKSTART.md)**               | Zero-to-first-loop getting started.                                                                                                 |
| **[docs/CLI.md](./docs/CLI.md)**                   | Every command, flag, and mode — start at [Choosing a mode](./docs/CLI.md#choosing-a-mode) (afk vs ghafk vs verify vs apply-review). |
| **[docs/CONFIG.md](./docs/CONFIG.md)**             | Environment variables, runner/sandbox, branch strategy, setup.                                                                      |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** | Runtime internals and data flow for library extenders.                                                                              |
| **[docs/MIGRATION.md](./docs/MIGRATION.md)**       | Task-grouped `.otto/tasks/<task-key>/` layout, old→new path mapping, branch-convention namespace, and how to migrate an existing repo. |
| **[docs/quality-report-samples.md](./docs/quality-report-samples.md)** | Filled-in sample quality reports — what good verification output looks like per run mode.                       |
| **[SECURITY.md](./SECURITY.md)**                   | Threat model and the `bypassPermissions` blast-radius story.                                                                        |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)**           | Dev loop, tests, adding a stage, release pipeline.                                                                                  |
| **[RELEASING.md](./RELEASING.md)**                 | release-please flow, version policy, secrets, rollback.                                                                             |

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
