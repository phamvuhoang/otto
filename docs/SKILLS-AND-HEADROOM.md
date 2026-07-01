# Otto + Skills & Headroom — what to use, and when

A short, opinionated map for bringing outside **skills** and **Headroom** into Otto. It answers _"which pack for which job, and how do I switch it on?"_ — the **why/when**. For the full clone → register → validate → activate steps (and gotchas), see **[INTEGRATIONS.md](./INTEGRATIONS.md)**; this guide links into it.

> New to Otto? Do the **[QUICKSTART](../QUICKSTART.md)** first. Everything below is **off by default** — a bare `otto-afk` run is unchanged until you opt in.

---

## The one-minute model

Otto extends a run two ways, and treats them differently:

- **Skills** = methodology/knowledge **injected into a stage's prompt** (plan, implement, review, report). A skill source is just a repo of `SKILL.md` packages. Lifecycle: **import → validate → activate**.
  - `import` brings it in **unverified** (inert).
  - `validate` (`otto-skills validate <skill>`) classifies it: **`afk-safe`** (any stage, unattended) · **`stage-scoped`** (only the stages its capability tags imply) · **`interactive-only`** (the body uses recognized **stop-and-wait language** — e.g. "do not proceed until", "STOP and wait", "wait for approval" — never injected on any stage) · **`blocked`** (an **error**-severity finding: unsafe shell, secret handling, or an attempt to overrule repo policy).
  - `activate` (`--use-skills`) injects only eligible, stage-matching skills as a **bounded, attributed** block (char-capped, so a long skill is **truncated** to an excerpt), recorded in `skillsUsed[]`.

  > **⚠️ The gate does _not_ block on network/browser/telemetry.** Those are **warnings** (`network-use`, `unsupported-tool`), not errors — a skill that calls the network, drives a browser, or phones home can still validate **`afk-safe`** and be injected. Only unsafe-shell / secret-handling / policy-override are auto-`blocked`. So **read the `otto-skills validate` findings and decide** — don't assume a network-touching skill is stopped for you.
  >
  > And the gate governs which guidance is _eligible_, not what the agent does after reading it. `.otto/policy.json` only checks **harness-rendered `!`/`@spill` commands and registered-tool calls** — it does **not** sandbox arbitrary shell/network the agent runs on its own. The agent's own actions are bounded by the **runner**: the default `OTTO_RUNNER=sandbox` confines writes to the workspace via the OS sandbox, while `OTTO_RUNNER=host` runs **unsandboxed**. Treat an injected skill like code you're about to run — point Otto only at packs you'd run yourself ([SECURITY.md](../SECURITY.md)).

- **Headroom** = a **tool**, not a skill. It compresses token-heavy `@spill` content (issue bodies, comments, diffs) **before the agent reads it**, reversibly. You enable it per run with `--context-compressor headroom` (or `OTTO_CONTEXT_COMPRESSOR` / config). `otto-extensions init context-saver` _also_ drops a `.otto/tools/headroom.json` entry so you can `otto-tools list` / `health` it — and that entry governs the compressor (disable the tool, or block its command in `.otto/policy.json`, to stop it), though it is **not** _stage_-gated the way per-stage tools are.

Everything is plain, git-trackable files under `.otto/`. To review or undo an import, see [Govern, lock & roll back](#govern-lock--roll-back) below — note imported files are **untracked** until you commit them, so `git diff` alone won't show them.

---

## Best use cases — reach for…

| You want to…                                                                       | Use                                             | Switch it on with                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Turn a thin PM idea into a sharp spec/plan (roadmap, PRD, problem-framing)         | **Product-Manager-Skills**                      | `otto-afk --plan --use-skills`           |
| Hold implementation to real discipline (TDD, systematic debugging, plan-execution) | **Superpowers**                                 | `otto-afk --use-skills`                  |
| Add one strict, static maintainability-review pass                                 | **Cursor `thermo-nuclear-code-quality-review`** | `otto-afk --review-panel --use-skills`   |
| Cut input tokens on long, context-heavy runs (big issue bodies, comments, diffs)   | **Headroom**                                    | `otto-afk --context-compressor headroom` |

> **Not in the table on purpose:** [gstack](https://github.com/garrytan/gstack) — its roles are interactive, side-effecting workflows (home-directory `rm -f ~/.gstack/…`, telemetry, decision gates, `git rm`/commit), so they validate **`blocked`** (the destructive `rm` trips `unsafe-shell`), not direct-use AFK skills. Use it as **inspiration**, not an import — [see below](#gstack--inspiration-not-a-direct-import).

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

- Even the "static-sounding" ones aren't. Its [`review`](https://github.com/garrytan/gstack/blob/main/review/SKILL.md) skill runs **home-directory deletes** (`rm -f ~/.gstack/…`, `rm -f ~/.gstack/analytics/…`), **telemetry**, **`git rm`/commit** during migration, and human **decision gates**, plus subagents. The `rm -f ~/…` lines trip Otto's **`unsafe-shell`** check (`rm` targeting `~`/`$VAR`/`/` is an error finding) → **`blocked`**. (Note: ordinary `mkdir` / `git branch` / `git commit` would _not_ block on their own — the gate flags specific **destructive** commands, secret handling, `sudo`, `curl|sh`, `chmod 777`, and stop-and-wait language; here it's the `rm -f ~/…`.) Either way it's an interactive, side-effecting workflow, not a usable AFK skill.
- Otto injects a **bounded, char-capped excerpt** of a skill's body. A long gstack role would be truncated — and the truncated head is the routing/setup **preamble**, not the actual workflow. So even the parts that aren't blocked wouldn't inject usefully.
- **Don't run gstack's `./setup`** either — it installs into `~/.claude/skills/gstack` and wires machine setup + telemetry for Claude Code, not Otto.

**How to actually use it:** read a role you like (`/review`, `/spec`) and **extract its core guidance into a small, sanitized, Otto-native `SKILL.md`** — strip the shell, telemetry, `AskUserQuestion`, and git/subagent steps; keep the methodology. Add a `capabilities:` tag, drop it in your own skills source, then `otto-skills validate` + `--use-skills` it like any other (steps in [INTEGRATIONS.md](./INTEGRATIONS.md#the-skill-lifecycle-applies-to-every-skill-source)). That's gstack as a _design reference_, which is where its value is for an autonomous harness.

---

## Headroom — context compression (a tool, not a skill)

[headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom): _"the context compression layer for AI agents"_ — Headroom reports **60–95% token reduction** on tool outputs/logs/diffs while _aiming to preserve answer quality_ (a benchmark figure, **not** a per-run guarantee), **reversible** (originals cached). **Best when** your runs are long and dominated by re-injected bulk: pasted GitHub/Linear issue bodies, comment threads, large diffs. It lowers input-token cost and degrades cleanly if absent — but Otto does **not** evaluate compressed-output quality each run, so treat it as a cost lever and confirm via the run's evidence (below) and your own evals.

Otto drives Headroom's real `compress()` library directly (no shim needed). Inference is **local** — no API key, no per-call cost — but install the **`[ml]`** extra (the base package leaves plain text unchanged), and note the ML model downloads once from Hugging Face on first use (see the warning):

```bash
pip install "headroom-ai[ml]"             # ML text compressor (base = passthrough)
export HEADROOM_MODEL=gpt-4o-mini         # optional: selects the tokenizer (this is the default)

otto-extensions init context-saver        # writes .otto/tools/headroom.json + sets contextCompressor: headroom
otto-tools health                         # probes the same binary a run would (see the note)
otto-afk --context-compressor headroom "./docs/plans/feature.md" 10
#   or persistently: OTTO_CONTEXT_COMPRESSOR=headroom, or .otto/config.json {"contextCompressor":"headroom"}
```

**Inspectability:** originals are retained under `.otto/runs/<id>/compressed/`; tokens before/after, savings, and latency show up in `otto-afk --context-report`.

> **⚠️ Local inference, but a one-time model download.** Compression runs **locally** with **no per-call API or cost** — `HEADROOM_MODEL` only picks the tokenizer. But the ML model (`kompress-base`, ~260–600 MB) is fetched from Hugging Face on first use. Otto runs the compressor with **`HF_HUB_OFFLINE=1` by default**, so a governed run never performs that fetch (no egress at all, no 30s-timeout blowout) — it uses cached weights or degrades cleanly. So **pre-warm the cache once** (compress a payload above Headroom's ~250-token threshold — a tiny string won't load the model — and confirm `tokens_saved > 0`; see [INTEGRATIONS.md §4](./INTEGRATIONS.md#4-headroom-context-compression-tool)), then runs are fully local. (Set `HF_HUB_OFFLINE=0` to let Otto download in-run — slower, and the resolved endpoint is **authorized** against `.otto/policy.json` **and** the tool's declared `networkDomains`, with `HF_HUB_DISABLE_XET=1` forced so transfers stay on the declared hosts; a mirror set via `HF_ENDPOINT` must be added to the tool's `networkDomains`.) After warming, the only question is reduction: Headroom shrinks **large, repetitive spills** the most and may barely move small ones — confirm `tokensSaved > 0` (not `degraded`) in `--context-report`.
>
> **How Otto talks to it:**
>
> - **Library mode (default).** Otto spawns `python3 -c <bridge>` calling `from headroom import compress`. Override the interpreter with `OTTO_HEADROOM_PYTHON` (e.g. a venv's python). Needs the library importable — missing it degrades cleanly to no compression.
> - **Command mode (escape hatch).** Set `OTTO_HEADROOM_BIN=<binary>` to use a custom compressor instead of the library; Otto then runs `<binary> compress --category <c>` (stdin→stdout).
> - **Health.** `otto-tools health` mirrors a run's binary resolution — it honors `OTTO_HEADROOM_PYTHON`/`OTTO_HEADROOM_BIN`, so it agrees with what a run would probe.
>
> If the library is missing or a custom binary's contract doesn't match, the run **degrades cleanly** to no compression — never a broken run.

→ Full steps: **[INTEGRATIONS.md §4](./INTEGRATIONS.md#4-headroom-context-compression-tool)**.

---

## Govern, lock & roll back

Imports are plain `.otto/` files under your control, but most are **newly created** (untracked until you commit them), so `git diff`/`git checkout` won't show or remove them.

**Commit (or stash) a clean baseline _before_ importing** — then rolling back is trivial and can't touch anything else. Without a baseline, clean up **by the specific paths** the import added (from `git status`), never with a blanket `git clean`:

```bash
otto-skills audit --external   # unpinned refs, missing licenses, dup names, drifted copies
otto-skills audit              # validated / unvalidated / stale / needs-revalidation
otto-tools audit               # unreachable tools, missing health checks, policy conflicts

git status --short .otto/      # exactly what the import/init touched:
#   "??" = a NEW (untracked) file → safe to delete
#   " M" = a TRACKED file was edited/overwritten → restore it, don't delete it

# 1. Restore every tracked file the import EDITED or overwrote. `otto-extensions init` merges
#    into .otto/config.json and union-merges .otto/policy.json, and can overwrite an existing
#    tool or a skill dir — so include whatever git status marked " M":
git checkout -- .otto/config.json .otto/policy.json \
                .otto/skills/sources.json .otto/skills.lock.json \
                .otto/tools/<edited-tool>.json .otto/skills/<overwritten-skill>/

# 2. Delete ONLY the paths git status marked new ("??"). `sync` writes one
#    .otto/skills/<skill-name>/ dir PER imported skill (often several per source):
rm -rf .otto/skills/<new-skill-a>/ .otto/skills/<new-skill-b>/
rm -f  .otto/tools/<new-tool>.json    # only if `??` — never rm a tool you already had
```

> ⚠️ **Don't `git clean -fd .otto/`** to undo an import — it deletes _every_ untracked file there, including your own hand-authored skills, and it still won't revert the **tracked** edits an `init` makes to `config.json` / `policy.json` / `sources.json` / `skills.lock.json`. Restore tracked files with `git checkout`; delete only the `??` paths. Paths first, always.

- **Never auto-trusted:** a famous source is still imported `unverified`; the **gate**, not the repo's reputation, decides eligibility.
- **Drift:** re-`sync` an upstream change and `otto-skills audit` flags it for revalidation; `--use-skills` won't inject a drifted skill until you re-`validate`.
- **What the files are:** `.otto/skills/sources.json` is the **source registry** (name, path, type) — a **`--type local` source has no pinned `ref`**, so it's not a version pin; pinning applies to `git`-type sources. `.otto/skills.lock.json` records the **resolved checksums** (and ref, when one exists) of what was imported — that's the drift/integrity record, not a source pin. Commit both to share the setup. Details: **[EXTENSIONS.md → update, lock & roll back](./EXTENSIONS.md#update-lock--roll-back)**.
