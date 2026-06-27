# Otto + Skills & Headroom — what to use, and when

A short, opinionated map for bringing outside **skills** and **Headroom** into Otto. It answers _"which pack for which job, and how do I switch it on?"_ — the **why/when**. For the full clone → register → validate → activate steps (and gotchas), see **[INTEGRATIONS.md](./INTEGRATIONS.md)**; this guide links into it.

> New to Otto? Do the **[QUICKSTART](../QUICKSTART.md)** first. Everything below is **off by default** — a bare `otto-afk` run is unchanged until you opt in.

---

## The one-minute model

Otto extends a run two ways, and treats them differently:

- **Skills** = methodology/knowledge **injected into a stage's prompt** (plan, implement, review, report). A skill source is just a repo of `SKILL.md` packages. Lifecycle: **import → validate → activate**.
  - `import` brings it in **unverified** (inert).
  - `validate` (`otto-skills validate <skill>`) classifies it: **`afk-safe`** (any stage, unattended) · **`stage-scoped`** (only the stages its capability tags imply) · **`interactive-only`** (needs a human — never injected in AFK) · **`blocked`** (unsafe shell / network / secret / overrules policy — never eligible).
  - `activate` (`--use-skills`) injects only eligible, stage-matching skills as a **bounded, attributed** block, recorded in `skillsUsed[]`.
- **Headroom** = a **tool**, not a skill. It compresses token-heavy `@spill` content (issue bodies, comments, diffs) **before the agent reads it**, reversibly. It runs under repo-local **tool authority** (`.otto/tools/`), never personal config: `--context-compressor headroom`.

Everything is plain, git-tracked files under `.otto/`. To review or undo any import: `git diff .otto/` / `git checkout .otto/`.

---

## Best use cases — reach for…

| You want to…                                                                       | Use                                             | Switch it on with                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Turn a thin PM idea into a sharp spec/plan (roadmap, PRD, problem-framing)         | **Product-Manager-Skills**                      | `otto-afk --plan --use-skills`                                                        |
| Hold implementation to real discipline (TDD, systematic debugging, plan-execution) | **Superpowers**                                 | `otto-afk --use-skills`                                                               |
| Add one brutal, static maintainability-review pass                                 | **Cursor `thermo-nuclear-code-quality-review`** | `otto-afk --review-panel --use-skills`                                                |
| Borrow Garry Tan's role-based workflow (spec / review / ship) — selectively        | **gstack**                                      | cherry-pick the static skills; see [below](#gstack--garry-tans-claude-code-role-pack) |
| Cut input tokens on long, context-heavy runs (big issue bodies, comments, diffs)   | **Headroom**                                    | `otto-afk --context-compressor headroom`                                              |

Rule of thumb: **skills sharpen _quality_** (better plan, stricter review, disciplined implement); **Headroom lowers _cost_** (fewer input tokens) with no quality change. They compose — use a planning skill **and** Headroom on the same run.

---

## Skills, pack by pack

The shared lifecycle (clone locally → `otto-skills sources add <name> <path> --type local` → `sync` → `validate` → `--use-skills`) is in **[INTEGRATIONS.md → skill lifecycle](./INTEGRATIONS.md#the-skill-lifecycle-applies-to-every-skill-source)**. The notes here are just _when to use each and what to watch for_.

### Superpowers — coding methodology → **implement + review**

[obra/superpowers](https://github.com/obra/Superpowers): composable coding skills (test-driven-development, systematic-debugging, executing-plans, …). **Best when** you want Otto's implementer/reviewer to follow a proven method instead of improvising.

- The disciplined ones (TDD, debugging) validate **`afk-safe`**/`stage-scoped` — inject them on implement/review.
- The interactive ones (brainstorming, live checkpoints) correctly validate **`interactive-only`** — skip them for AFK, or use them under `--plan` with a human present.

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

### gstack — Garry Tan's Claude Code role pack → **cherry-pick**

[garrytan/gstack](https://github.com/garrytan/gstack): _"23 opinionated tools that serve as CEO, Designer, Eng Manager, Release Manager, Doc Engineer, and QA."_ Each role (`/office-hours`, `/design`, `/review`, `/qa`, `/ship`, `/spec`, …) is a `SKILL.md` package — the same shape Otto imports.

**Read this before you wire it up — gstack is the most "bring-your-own-judgment" of these packs:**

- It's built for **interactive Claude Code slash commands**; many roles expect a human in the loop → they validate **`interactive-only`** (not injected in AFK).
- Several roles do **real-browser automation (with anti-bot stealth), network calls, and telemetry to Supabase** → Otto's safety gate validates those **`blocked`**. That's correct and expected — Otto won't run network/browser/telemetry skills unattended.
- **Do NOT run gstack's `./setup`.** Its quick-start installs into `~/.claude/skills/gstack` and runs machine setup + telemetry — that targets Claude Code's own skill dir, **not** Otto. For Otto, clone to a plain directory and register it as a **local source** instead:

```bash
# Plain clone (NOT into ~/.claude/skills, and don't run ./setup)
git clone --depth 1 https://github.com/garrytan/gstack ~/otto-skills/gstack

cd ~/my-project
otto-skills sources add gstack ~/otto-skills/gstack --type local
otto-skills sync
otto-skills list                 # imported unverified — nothing active yet
otto-skills validate spec        # keep the ones that pass afk-safe / stage-scoped…
otto-skills validate review      # …and let the gate flag the interactive/blocked rest
```

**What's worth using with Otto:** the **static, single-pass** roles — `spec`, `plan`, `review` — that classify `afk-safe`/`stage-scoped`. Tag them to a stage (`capabilities: [code-review]`, etc., per [INTEGRATIONS.md → scoping](./INTEGRATIONS.md#scoping-a-skill-to-a-stage)) and activate as usual. Treat the browser/QA/ship/office-hours roles as **interactive Claude Code tools**, not AFK Otto skills — `otto-skills validate` will tell you which is which, so let it.

---

## Headroom — context compression (a tool, not a skill)

[headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom): _"the context compression layer for AI agents"_ — 60–95% token reduction on tool outputs/logs/diffs, **reversible** (originals cached). **Best when** your runs are long and dominated by re-injected bulk: pasted GitHub/Linear issue bodies, comment threads, large diffs. It lowers input-token cost with no quality change, and degrades cleanly if absent.

```bash
otto-extensions init context-saver        # writes .otto/tools/headroom.json + sets the compressor default
otto-tools health                         # probes the binary (runs `headroom --version`)
otto-afk --context-compressor headroom "./docs/plans/feature.md" 10
#   or persistently: OTTO_CONTEXT_COMPRESSOR=headroom, or .otto/config.json {"contextCompressor":"headroom"}
```

**Inspectability:** originals are retained under `.otto/runs/<id>/compressed/`; tokens before/after, savings, and latency show up in `otto-afk --context-report`.

> **⚠️ Binary contract — check this once.** Otto's command-mode adapter shells out to a local `headroom` binary expecting exactly:
>
> - `headroom --version` → health probe
> - `headroom compress --category <category>` → **content on stdin, compressed text on stdout**
>
> Upstream `headroom-ai` (`pip install "headroom-ai[all]"` / `npm install headroom-ai`) is **proxy/library-first** (`headroom proxy`, `headroom wrap`, …) and may not expose that exact `compress` sub-command. If it doesn't, give Otto a tiny shim named `headroom` on `PATH` (or point `OTTO_HEADROOM_BIN` at it) that maps `compress --category <c>` (stdin→stdout) onto Headroom's library. If the binary is missing or the contract doesn't match, `otto-tools health` flags it and the run **degrades cleanly** to no compression — never a broken run.

→ Full steps: **[INTEGRATIONS.md §4](./INTEGRATIONS.md#4-headroom-context-compression-tool)**.

---

## Govern, lock & roll back

Imports are plain `.otto/` files under your control:

```bash
otto-skills audit --external   # unpinned refs, missing licenses, dup names, drifted copies
otto-skills audit              # validated / unvalidated / stale / needs-revalidation
otto-tools audit               # unreachable tools, missing health checks, policy conflicts
git diff .otto/                # exactly what an import/init changed
git checkout .otto/            # roll it all back
```

- **Never auto-trusted:** a famous source is still imported `unverified`; the **gate**, not the repo's reputation, decides eligibility.
- **Drift:** re-`sync` an upstream change and `otto-skills audit` flags it for revalidation; `--use-skills` won't inject a drifted skill until you re-`validate`.
- **Lock:** commit `.otto/skills/sources.json` (the pin) + `.otto/skills.lock.json` (checksums). Details: **[EXTENSIONS.md → update, lock & roll back](./EXTENSIONS.md#update-lock--roll-back)**.
