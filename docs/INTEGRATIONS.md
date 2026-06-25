# Integrating external skills & tools — from scratch

Step-by-step recipes for bringing outside **skills** (Superpowers, Product-Manager-Skills, a single Cursor review skill) and **tools** (Headroom) into Otto, safely. Every integration follows Otto's governance model: **import → validate → activate** for skills, **register under policy** for tools. Nothing influences a run until you opt in.

> **Prerequisites:** Otto installed (`npm i -g @phamvuhoang/otto`), run from inside a git repo. New to Otto? Start with the [QUICKSTART](../QUICKSTART.md).

> **One current limitation:** skill `sync` resolves **local** source directories today (networked `git`/`archive` fetch is a later slice). So the working path is: **clone the pack locally, then register it as a `--type local` source.** The `git`-based profiles in [EXTENSIONS.md](./EXTENSIONS.md) set up activation config but can't `sync` yet — use the local flow below to actually import.

---

## The skill lifecycle (applies to every skill source)

```bash
# 1. Get the pack onto disk (you control this clone)
git clone https://github.com/<owner>/<pack> ~/otto-skills/<pack>

# 2. Register it as a local source (one-time per repo)
otto-skills sources add <name> ~/otto-skills/<pack> --type local

# 3. Preview, then import (imports as trust=unverified — inert)
otto-skills sync --dry-run
otto-skills sync

# 4. Inventory + validate each skill you want (the P17 gate)
otto-skills list
otto-skills validate <skill>        # → afk-safe | interactive-only | stage-scoped | blocked

# 5. Preview routing, then activate (off by default)
otto-skills why --stage implementer
otto-afk --use-skills "./docs/plans/feature.md" 10

# 6. Confirm what shaped the run
otto-inspect latest                 # "Skills applied (…)" + per-stage skills line
```

**What the gate decides** (`otto-skills validate`):

- `afk-safe` — usable on any stage unattended.
- `interactive-only` — the skill stops for human input; **never injected in AFK** (useful in `--plan`/human-guided modes). Superpowers' brainstorming/checkpoint skills land here — that's correct.
- `stage-scoped` — valid only on the stages its capabilities imply (e.g. `code-review` → review).
- `blocked` — a policy/safety violation (unsafe shell, secret handling, an attempt to overrule repo policy). Not eligible anywhere.

A validated skill is **eligible, not auto-applied**. Activation (`--use-skills`) then injects only eligible, stage-matching skills as a bounded, attributed block, recorded in `skillsUsed[]`.

### Scoping a skill to a stage

Routing keys on a skill's **capability tags**. Packs that declare `capabilities:` in their `SKILL.md` frontmatter (some Superpowers skills) scope themselves. Packs that don't (Product-Manager-Skills, the Cursor skill) import with **no capabilities** → they classify `afk-safe` (injected on every activated stage). To pin one to a single stage, add a capability tag to your **local clone's** `SKILL.md` frontmatter before `sync` (survives re-sync):

```yaml
---
name: thermo-nuclear-code-quality-review
capabilities: [code-review] # → routes to the review stage only
---
```

Otto maps these tags to stage families: `planning`/`roadmap-planning`/`prd`/`problem-framing` → **plan**; `tdd`/`coding`/`refactor` → **implement**; `code-review`/`review`/`security`/`structural` → **review**; `reporting` → **report**; `context-engineering` → tool-output. Re-run `otto-skills sync && otto-skills validate <skill>` after editing.

> If you instead edit the imported `.otto/skills/<skill>/skill.json` directly, a later `otto-skills sync` will overwrite it from the source — edit the source clone's frontmatter to make it stick.

---

## 1. Superpowers (coding methodology)

[obra/superpowers](https://github.com/obra/superpowers) — composable coding skills (TDD, systematic debugging, plan execution, …). Layout: `skills/<name>/SKILL.md`. Many are AFK-safe; the interactive ones (brainstorming, live checkpoints) are correctly flagged `interactive-only`.

```bash
git clone https://github.com/obra/superpowers ~/otto-skills/superpowers
cd ~/my-project

otto-skills sources add superpowers ~/otto-skills/superpowers --type local
otto-skills sync
otto-skills list                         # see what imported (trust: unverified)

# Validate the coding skills you want on implement/review
otto-skills validate test-driven-development
otto-skills validate systematic-debugging
# (brainstorming → interactive-only; that's expected — skip it for AFK)

# Activate, scoped to implement + review only
otto-afk --use-skills "./docs/plans/feature.md" 10
```

Per-repo config instead of the flag — `.otto/config.json`:

```json
{ "skills": { "enabled": true, "implement": true, "review": true } }
```

Shortcut for the activation config (still import locally as above): `otto-extensions init coding-superpowers`.

---

## 2. Product-Manager-Skills (planning frameworks)

[deanpeters/Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills) — roadmap, prioritization, PRD, discovery, problem-framing. Layout: `skills/<name>/SKILL.md`. These declare **no `capabilities`**, and ~half are interactive workshops — so scope the ones you want and let the gate flag the rest.

```bash
git clone https://github.com/deanpeters/Product-Manager-Skills ~/otto-skills/pm-skills

# Tag the few you want to plan with (edit the local clone's frontmatter)
#   skills/prd-development/SKILL.md      → capabilities: [prd]
#   skills/roadmap-planning/SKILL.md     → capabilities: [roadmap-planning]
#   skills/problem-statement/SKILL.md    → capabilities: [problem-framing]

cd ~/my-project
otto-skills sources add pm-skills ~/otto-skills/pm-skills --type local
otto-skills sync
otto-skills validate prd-development      # → stage-scoped (plan) once tagged
otto-skills validate roadmap-planning

# Use during planning — the PM frameworks shape the authored spec
otto-afk --plan --use-skills "./docs/ideas/new-product.md"
```

Config: `{ "skills": { "enabled": true, "plan": true, "report": true } }` (or `otto-extensions init pm-planning`).

---

## 3. A single Cursor skill (thermo-nuclear code-quality review)

Pull just one skill out of a larger repo — [cursor/plugins → `thermo-nuclear-code-quality-review`](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md). It's a strict maintainability-review framework: a static review skill, AFK-safe, no shell/network/interactive steps. Its frontmatter declares `name` + `description` (and `disable-model-invocation`, which Otto ignores — Otto's own activation gate controls use), but **no `capabilities`**.

```bash
git clone https://github.com/cursor/plugins ~/otto-skills/cursor-plugins

# Scope it to the review stage: add to the local SKILL.md frontmatter
#   ~/otto-skills/cursor-plugins/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md
#   capabilities: [code-review]

cd ~/my-project
# Point the source at the skills/ dir — Otto walks it for SKILL.md packages
otto-skills sources add cursor ~/otto-skills/cursor-plugins/cursor-team-kit/skills --type local
otto-skills sync
otto-skills validate thermo-nuclear-code-quality-review   # → stage-scoped (review)

# Use it to harden Otto's own review pass
otto-afk --review-panel --use-skills "./docs/plans/feature.md" 20
```

The skill now shapes the reviewer stage; `otto-inspect latest` shows it under "Skills applied" with its source + checksum.

---

## 4. Headroom (context-compression **tool**)

Headroom is a **tool**, not a skill — it compresses token-heavy `@spill` content (issue bodies, comments, diffs) before the agent reads them, reversibly. It runs under Otto's repo-local **tool authority** (P19), never from personal config.

```bash
# 1. Install the Headroom binary (see https://github.com/headroomlabs-ai/headroom).
#    Otto calls `headroom --version` (health) and `headroom compress` (stdin→stdout).
#    Override the binary path with OTTO_HEADROOM_BIN if it's not on PATH.

# 2. Register the tool + set the compressor default
otto-extensions init context-saver        # writes .otto/tools/headroom.json + config
#   (or by hand: .otto/config.json { "contextCompressor": "headroom" })

# 3. Confirm authority + availability
otto-tools list                            # headroom [command]
otto-tools health                          # runs `headroom --version`

# 4. Run — compression happens at the @spill boundary
otto-afk --context-compressor headroom "./docs/plans/feature.md" 10
#   or persistently: OTTO_CONTEXT_COMPRESSOR=headroom, or the config above
```

**Inspectability:** originals are retained under `.otto/runs/<id>/compressed/`; tokens before/after, savings, and latency are recorded and surfaced in `otto-afk --context-report`. A missing or failing `headroom` **degrades cleanly** to normal behavior with a warning — never a broken run.

---

## Govern, lock & roll back

Everything above is plain, git-tracked files under `.otto/` — inspect and reverse with ordinary git:

```bash
otto-skills audit --external    # unpinned refs, missing licenses, dup names, drifted copies
otto-skills audit               # validated / unvalidated / stale / needs-revalidation
otto-tools audit                # unreachable tools, missing health checks, policy conflicts
git diff .otto/                 # exactly what an import/init changed
git checkout .otto/             # roll it all back
```

- **Drift:** if an upstream skill changes and you re-`sync`, `otto-skills audit` flags it as needing revalidation; `--use-skills` won't inject a drifted skill until you re-`validate`.
- **Lock:** commit `.otto/skills/sources.json` (the pin) and `.otto/skills.lock.json` (resolved checksums). See [EXTENSIONS.md → Update, lock & roll back](./EXTENSIONS.md#update-lock--roll-back).
- **Never auto-trusted:** a famous source is still imported `unverified`; the gate, not the repo's reputation, decides eligibility.
