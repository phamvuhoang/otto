# Otto + Skills & Headroom — what to use, and when

A short, opinionated map for bringing outside **skills** and **Headroom** into Otto. It answers _"which pack for which job, and how do I switch it on?"_ — the **why/when**. For the full clone → register → validate → activate steps (and gotchas), see **[INTEGRATIONS.md](./INTEGRATIONS.md)**; this guide links into it.

> New to Otto? Do the **[QUICKSTART](../QUICKSTART.md)** first. Everything below is **off by default** — a bare `otto-afk` run is unchanged until you opt in.

---

## The one-minute model

Otto extends a run two ways, and treats them differently:

- **Skills** = methodology/knowledge **injected into a stage's prompt** (plan, implement, review, report). A skill source is just a repo of `SKILL.md` packages. Lifecycle: **import → validate → activate**.
  - `import` brings it in **unverified** (inert).
  - `validate` (`otto-skills validate <skill>`) classifies it: **`afk-safe`** (any stage, unattended) · **`stage-scoped`** (only the stages its capability tags imply) · **`interactive-only`** (an interactive hard-stop, e.g. `AskUserQuestion` / stop-and-wait — never injected on any stage) · **`blocked`** (an **error**-severity finding: unsafe shell, secret handling, or an attempt to overrule repo policy).
  - `activate` (`--use-skills`) injects only eligible, stage-matching skills as a **bounded, attributed** block (char-capped, so a long skill is **truncated** to an excerpt), recorded in `skillsUsed[]`.

  > **⚠️ The gate does _not_ block on network/browser/telemetry.** Those are **warnings** (`network-use`, `unsupported-tool`), not errors — a skill that calls the network, drives a browser, or phones home can still validate **`afk-safe`** and be injected. Only unsafe-shell / secret-handling / policy-override are auto-`blocked`. So **read the `otto-skills validate` findings and decide** — don't assume a network-touching skill is stopped for you. (What the skill _text_ tells the agent to do still runs inside Otto's sandbox + `.otto/policy.json`; the skill gate governs eligibility of the guidance, not every action it suggests.)

- **Headroom** = a **tool**, not a skill. It compresses token-heavy `@spill` content (issue bodies, comments, diffs) **before the agent reads it**, reversibly. You enable it per run with `--context-compressor headroom` (or `OTTO_CONTEXT_COMPRESSOR` / config). `otto-extensions init context-saver` _also_ drops a `.otto/tools/headroom.json` entry so you can `otto-tools list` / `health` it — but note the runtime constructs the compressor straight from that config flag; it is **not** gated per-stage through tool policy the way registered tools are.

Everything is plain, git-tracked files under `.otto/`. To review or undo an import, see [Govern, lock & roll back](#govern-lock--roll-back) below — note imported files are **untracked** until you commit them, so `git diff` alone won't show them.

---

## Best use cases — reach for…

| You want to…                                                                       | Use                                             | Switch it on with                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Turn a thin PM idea into a sharp spec/plan (roadmap, PRD, problem-framing)         | **Product-Manager-Skills**                      | `otto-afk --plan --use-skills`           |
| Hold implementation to real discipline (TDD, systematic debugging, plan-execution) | **Superpowers**                                 | `otto-afk --use-skills`                  |
| Add one strict, static maintainability-review pass                                 | **Cursor `thermo-nuclear-code-quality-review`** | `otto-afk --review-panel --use-skills`   |
| Cut input tokens on long, context-heavy runs (big issue bodies, comments, diffs)   | **Headroom**                                    | `otto-afk --context-compressor headroom` |

> **Not in the table on purpose:** [gstack](https://github.com/garrytan/gstack) — its roles are interactive workflows (shell setup, telemetry, `AskUserQuestion` gates, git ops), so they validate `blocked` or `interactive-only`, not direct-use AFK skills. Use it as **inspiration**, not an import — [see below](#gstack--inspiration-not-a-direct-import).

Rule of thumb: **skills sharpen _quality_** (better plan, stricter review, disciplined implement); **Headroom lowers _cost_** (fewer input tokens) while _aiming_ to preserve quality. They compose — use a planning skill **and** Headroom on the same run, then check the run's evidence to confirm nothing important was lost.

---

## Skills, pack by pack

The shared lifecycle (clone locally → `otto-skills sources add <name> <path> --type local` → `sync` → `validate` → `--use-skills`) is in **[INTEGRATIONS.md → skill lifecycle](./INTEGRATIONS.md#the-skill-lifecycle-applies-to-every-skill-source)**. The notes here are just _when to use each and what to watch for_.

### Superpowers — coding methodology → **implement + review**

[obra/superpowers](https://github.com/obra/Superpowers): composable coding skills (test-driven-development, systematic-debugging, executing-plans, …). **Best when** you want Otto's implementer/reviewer to follow a proven method instead of improvising.

- The disciplined ones (TDD, debugging) validate **`afk-safe`**/`stage-scoped` — inject them on implement/review.
- The interactive ones (brainstorming, live checkpoints) correctly validate **`interactive-only`**. Otto runs the agent non-interactively, so `--use-skills` **never injects these on any stage** (including `--plan`) — there is no human-attended path that re-enables them. Run those directly in Claude Code if you want them; for Otto, skip them.

```bash
otto-afk --use-skills "./docs/plans/feature.md" 10
```

→ Full steps + config: **[INTEGRATIONS.md §1](./INTEGRATIONS.md#1-superpowers-coding-methodology)**. Shortcut for the activation config: `otto-extensions init coding-superpowers`.

### Product-Manager-Skills — planning frameworks → **plan**

[deanpeters/Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills): roadmap, prioritization, PRD, discovery, problem-framing. **Best when** the input is a rough idea and you want a stronger spec _before_ any code — the cheapest place to prevent rework. Pairs naturally with `--plan` and Otto's plan gate (a deeper plan scores better and is less likely to be re-planned).

These declare **no `capabilities`** and ~half are interactive workshops, so **tag the few you want** (e.g. `prd-development → capabilities: [prd]`) in your local clone's frontmatter and let the gate flag the rest.

```bash
otto-afk --plan --use-skills "./docs/ideas/new-product.md"
```

→ Full steps: **[INTEGRATIONS.md §2](./INTEGRATIONS.md#2-product-manager-skills-planning-frameworks)**. Config shortcut: `otto-extensions init pm-planning`.

### Cursor `thermo-nuclear-code-quality-review` — one skill → **review**

[The single skill](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) pulled out of `cursor/plugins`. A strict, **static** maintainability-review framework — no shell/network/interactive steps, so it validates **`afk-safe`**, and scopes cleanly to **review** once you tag it `capabilities: [code-review]`. **Best when** you want Otto's review pass to be harsher and more consistent than its default reviewer.

```bash
otto-afk --review-panel --use-skills "./docs/plans/feature.md" 20
```

→ Full steps (including pointing the source at the right sub-dir): **[INTEGRATIONS.md §3](./INTEGRATIONS.md#3-a-single-cursor-skill-thermo-nuclear-code-quality-review)**.

### gstack — inspiration, not a direct import

[garrytan/gstack](https://github.com/garrytan/gstack): _"23 opinionated tools that serve as CEO, Designer, Eng Manager, Release Manager, Doc Engineer, and QA."_ Each role (`/office-hours`, `/design`, `/review`, `/qa`, `/ship`, `/spec`, …) is a `SKILL.md`, the shape Otto imports — but **don't import gstack roles into Otto directly.** They are interactive Claude Code workflows, not single-pass guidance:

- Even the "static-sounding" ones aren't. Its [`spec`](https://github.com/garrytan/gstack/blob/main/spec/SKILL.md) and [`review`](https://github.com/garrytan/gstack/blob/main/review/SKILL.md) skills run **shell setup** (`mkdir`, `git branch`), **append telemetry** (`~/.gstack/analytics/…`, brain-sync), present **`AskUserQuestion` stop-and-wait gates**, perform **GitHub operations** (`git add && git commit`), and **dispatch subagents**. Under Otto's gate that's `blocked` (unsafe shell) or `interactive-only` — not a usable AFK skill.
- Otto injects a **bounded, char-capped excerpt** of a skill's body. A long gstack role would be truncated — and the truncated head is the routing/setup **preamble**, not the actual workflow. So even the parts that aren't blocked wouldn't inject usefully.
- **Don't run gstack's `./setup`** either — it installs into `~/.claude/skills/gstack` and wires machine setup + telemetry for Claude Code, not Otto.

**How to actually use it:** read a role you like (`/review`, `/spec`) and **extract its core guidance into a small, sanitized, Otto-native `SKILL.md`** — strip the shell, telemetry, `AskUserQuestion`, and git/subagent steps; keep the methodology. Add a `capabilities:` tag, drop it in your own skills source, then `otto-skills validate` + `--use-skills` it like any other (steps in [INTEGRATIONS.md](./INTEGRATIONS.md#the-skill-lifecycle-applies-to-every-skill-source)). That's gstack as a _design reference_, which is where its value is for an autonomous harness.

---

## Headroom — context compression (a tool, not a skill)

[headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom): _"the context compression layer for AI agents"_ — Headroom reports **60–95% token reduction** on tool outputs/logs/diffs while _aiming to preserve answer quality_ (a benchmark figure, **not** a per-run guarantee), **reversible** (originals cached). **Best when** your runs are long and dominated by re-injected bulk: pasted GitHub/Linear issue bodies, comment threads, large diffs. It lowers input-token cost and degrades cleanly if absent — but Otto does **not** evaluate compressed-output quality each run, so treat it as a cost lever and confirm via the run's evidence (below) and your own evals.

```bash
otto-extensions init context-saver        # writes .otto/tools/headroom.json + sets contextCompressor: headroom
otto-tools health                         # runs the literal `headroom --version` (see the binary note)
otto-afk --context-compressor headroom "./docs/plans/feature.md" 10
#   or persistently: OTTO_CONTEXT_COMPRESSOR=headroom, or .otto/config.json {"contextCompressor":"headroom"}
```

**Inspectability:** originals are retained under `.otto/runs/<id>/compressed/`; tokens before/after, savings, and latency show up in `otto-afk --context-report`.

> **⚠️ Binary contract — check this once.** Otto's command-mode adapter shells out to a local `headroom` binary expecting exactly:
>
> - `headroom --version` → health probe
> - `headroom compress --category <category>` → **content on stdin, compressed text on stdout**
>
> Two mismatches to know about:
>
> 1. **Upstream interface.** `headroom-ai` (`pip install "headroom-ai[all]"` / `npm install headroom-ai`) is **proxy/library-first** (`headroom proxy`, `headroom wrap`, …) and may not expose that exact `compress` sub-command. If it doesn't, give Otto a tiny shim named `headroom` (or point `OTTO_HEADROOM_BIN` at it) that maps `compress --category <c>` (stdin→stdout) onto Headroom's library.
> 2. **`OTTO_HEADROOM_BIN` vs `otto-tools health`.** The **runtime** compressor honors `OTTO_HEADROOM_BIN`, but `otto-tools health` runs the **literal** `headroom --version` from `.otto/tools/headroom.json` and ignores the override — so if you relocate the binary via `OTTO_HEADROOM_BIN`, `otto-tools health` can report red while a run still compresses (or vice-versa). Trust the actual run's `--context-report` over `otto-tools health`.
>
> If the binary is missing or the contract doesn't match, the run **degrades cleanly** to no compression — never a broken run.

→ Full steps: **[INTEGRATIONS.md §4](./INTEGRATIONS.md#4-headroom-context-compression-tool)**.

---

## Govern, lock & roll back

Imports are plain `.otto/` files under your control. Because most are **newly created** (untracked until you commit them), use `git status`, not `git diff`, to see them — and remember `git checkout` only restores _tracked_ files:

```bash
otto-skills audit --external   # unpinned refs, missing licenses, dup names, drifted copies
otto-skills audit              # validated / unvalidated / stale / needs-revalidation
otto-tools audit               # unreachable tools, missing health checks, policy conflicts

git status --short .otto/      # what an import/init added — incl. new (untracked, "??") files
git checkout -- .otto/         # restore files that already existed (tracked edits)
git clean -nd .otto/skills/    # PREVIEW deleting the newly-imported (untracked) skill files…
git clean -fd .otto/skills/    # …then actually remove them to fully roll back an import
```

- **Never auto-trusted:** a famous source is still imported `unverified`; the **gate**, not the repo's reputation, decides eligibility.
- **Drift:** re-`sync` an upstream change and `otto-skills audit` flags it for revalidation; `--use-skills` won't inject a drifted skill until you re-`validate`.
- **What the files are:** `.otto/skills/sources.json` is the **source registry** (name, path, type) — a **`--type local` source has no pinned `ref`**, so it's not a version pin; pinning applies to `git`-type sources. `.otto/skills.lock.json` records the **resolved checksums** (and ref, when one exists) of what was imported — that's the drift/integrity record, not a source pin. Commit both to share the setup. Details: **[EXTENSIONS.md → update, lock & roll back](./EXTENSIONS.md#update-lock--roll-back)**.
