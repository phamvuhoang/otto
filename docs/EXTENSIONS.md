# Extension profiles

Curated, lockable bundles that combine the Phase-4 primitives — skill sources (P16), the validation gate (P17), runtime activation (P18), and the tool-authority layer (P19/P20) — into one opinionated starting point for a common job.

`otto-extensions init <profile>` writes **normal, inspectable config** — the same files you could write by hand:

- `.otto/skills/sources.json` — registered (pinned) skill sources
- `.otto/tools/<name>.json` — tool adapters
- `.otto/config.json` — activation / compressor defaults
- `.otto/policy.json` — safety-policy additions (union-merged, never relaxed)

A profile is **generated config, not hidden behavior**: inspect it, edit it, diff it, roll it back. Enabling a profile does **not** auto-trust anything — a registered source is still imported `unverified` and must clear the P17 gate before P18 will inject it; a registered tool's **invocations** are policy-scoped. (Nuance for the Headroom **runtime compressor**: it's enabled from `contextCompressor` config and governed by the registered tool's `enabled` flag + `.otto/policy.json`, but it is **not** _stage_-gated — it runs at the render boundary, not per stage.)

> Want a from-scratch, per-pack walkthrough (Superpowers, Product-Manager-Skills, a single Cursor skill, Headroom) — clone → register → validate → activate, with the gotchas? See **[INTEGRATIONS.md](./INTEGRATIONS.md)**.

```bash
otto-extensions list                       # show the curated profiles
otto-extensions init context-saver --dry-run   # preview every file it would write
otto-extensions init context-saver         # write it
git status --short .otto/                  # review what changed — new files are untracked
#                                            ("??"); `git diff` alone won't list them
```

## Profiles

| Profile                 | Writes                                                              | For                                                                                    |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `coding-superpowers`    | `superpowers` source (pinned) + `skills.{enabled,implement,review}` | Superpowers coding methodology on the implement + review stages.                       |
| `pm-planning`           | `pm-skills` source (pinned) + `skills.{enabled,plan,report}`        | PM frameworks (roadmap, prioritization, PRD, framing) on plan/report.                  |
| `context-saver`         | `headroom` tool + `contextCompressor: "headroom"`                   | Headroom token compression (local, no API key) with P7 context-report defaults.        |
| `security-review`       | `skills.{enabled,review}` + stricter `.otto/policy.json`            | Security/structural review posture + tighter governance.                               |
| `codebase-intelligence` | `codebase-memory` tool (`enabled: true`, `stages: []`)              | Codebase Memory local code-knowledge graph (P26, spike — report/eval-only, see below). |

## Compatibility matrix

| Profile                 | Source / tool                                  | Pinned ref | Required local binaries                    | Tested Otto | Known limits                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------- | ---------- | ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coding-superpowers`    | `github.com/obra/superpowers` (git)            | `v6.0.3`   | `git`                                      | 0.x         | Git source `sync` is not implemented yet (P16 starts local) — vendor locally or wait for git fetch.                                                                                                                                                                              |
| `pm-planning`           | `github.com/deanpeters/Product-Manager-Skills` | `v1.0.0`   | `git`                                      | 0.x         | Same git-`sync` limitation; PM skills classify `stage-scoped` to plan/report.                                                                                                                                                                                                    |
| `context-saver`         | `headroom` (library mode)                      | n/a        | `python3` + `headroom-ai[ml]`              | 0.x         | Local inference, no API key (`model` only selects the tokenizer), but first use downloads the kompress-base model (~260–600 MB) from Hugging Face — pre-warm + `HF_HUB_OFFLINE=1`. `otto-tools health` fails until `headroom-ai[ml]` is importable; degrades cleanly without it. |
| `security-review`       | policy only                                    | n/a        | none                                       | 0.x         | Pairs with `--review-panel`; review the generated `.otto/policy.json` and tighten further.                                                                                                                                                                                       |
| `codebase-intelligence` | `codebase-memory` (MCP stdio)                  | n/a        | operator-provided `codebase-memory` binary | 0.x (spike) | Spike scope: report/eval-only, no live prompt injection, no indexing of a live target. `otto-tools health` needs the pinned binary on `PATH`; see [Codebase Memory (P26, spike)](#codebase-memory-p26-spike) below.                                                              |

> The pinned refs live in one place (`extension-profiles.ts`) so this matrix and the manifests cannot drift. Until git-source `sync` lands, register the source then point it at a local checkout (`otto-skills sources add <name> <path> --type local`) to import.

## After `init`: validate, then activate

A profile registers sources and turns activation **on in config**, but skills still pass through the P17 gate before P18 injects them:

```bash
otto-extensions init coding-superpowers
otto-skills sync                      # import the source's skills (unverified)
otto-skills validate <skill>          # gate → afk-safe | interactive-only | stage-scoped | blocked
otto-afk --use-skills "./plan.md" 10  # only validated, eligible skills are injected
```

For `context-saver`, install the Headroom library with the `[ml]` extra (local inference, no API key; first use downloads the model from Hugging Face — pre-warm it), then confirm it resolves:

```bash
pip install "headroom-ai[ml]"         # ML text compressor (base = passthrough); no API key
otto-extensions init context-saver
otto-tools health                     # mirrors a run's binary resolution — honors
#                                       OTTO_HEADROOM_BIN / OTTO_HEADROOM_PYTHON
otto-afk "./plan.md" 10               # the compressor is now the config default
```

The `.otto/tools/headroom.json` entry is the **inspection/health** surface **and** a governance hook: disabling the tool (registry `enabled: false` or a config override) or blocking its command in `.otto/policy.json` stops the compressor. It is **not** _stage_-gated, though — the compressor runs at the render boundary, not per stage.

## Codebase Memory (P26, spike)

`codebase-intelligence` registers a local code-knowledge graph (architecture summaries, call-path tracing, symbol search) via an Otto-owned MCP stdio child, following the same adapter pattern as Headroom. **This is a spike, not a production feature:** it is **report/eval-only** — nothing here injects graph results into a live plan/implement/review/verify prompt, and this slice does not index a live target. It exists so the eval harness can measure whether structural retrieval is worth wiring into a stage later (P26 in the Phase 5 roadmap, `docs/HARNESS_ROADMAP_PHASE5.md`).

```bash
otto-extensions init codebase-intelligence --dry-run  # preview the .otto/tools/codebase-memory.json it writes
otto-extensions init codebase-intelligence
otto-tools health                                     # requires the pinned binary on PATH
otto-tools why plan                                   # confirms stages: [] — no stage is authorized to use it
```

**You bring the binary.** Otto never runs the upstream install/update — you provide an operator-provided, checksum-pinned `codebase-memory` binary (verify it yourself against the upstream release before trusting it) and put it on `PATH` (or point the runner's `command` at it). Otto only spawns it as a stdio child; it never mutates personal agent config (`.claude/.mcp.json`, `.codex/config.toml`, hooks, or instruction files).

**Governance:**

- `networkDomains: []` — no runtime network authority; the graph lives entirely in a local cache.
- `writeRoots: [".codebase-memory"]` — all writes are confined to the tool's own cache directory.
- A **write inventory** (`diffWriteInventory`) records every file `index_repository` writes during a run and flags any that escape the declared write roots.
- An **index freshness contract** classifies a persisted index as `fresh`, `stale`, `absent`, or `wrong-project` against the current workspace/revision; anything other than `fresh` falls back to Otto's normal search/read path instead of silently trusting a stale or foreign graph.
- The tool definition itself ships `enabled: false` / `stages: []`; `otto-extensions init codebase-intelligence` flips `enabled: true` but leaves `stages: []` — no stage is wired to call it until a later slice earns that.

**Running the gated benchmark.** With the pinned binary installed and `OTTO_CBM_E2E=1` set, record a run with the tool off and one with it on, then compare them:

```bash
OTTO_CBM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- cbm-e2e   # proves the stdio round-trip works
otto-eval compare cbm-off cbm-on   # A/B two recorded runs by id — task success, tokens, tool calls
```

## Update, lock & roll back

Profiles are just files under `.otto/`, **git-trackable** (new files are untracked until you commit them) — so update/lock/rollback are ordinary git + edit operations.

- **Inspect** what a profile changed: `git status --short .otto/` right after `init` (new files show as untracked `??`; `git diff` alone won't list them).
- **Lock**: commit `.otto/skills/sources.json` (the source **registry** — a `--type local` source has **no pinned `ref`**; pinning applies to `git` sources) and `.otto/skills.lock.json` (resolved **checksums** from `otto-skills sync` — the drift/integrity record, not a source pin).
- **Update**: for a `git` source, bump its `ref` in `.otto/skills/sources.json`, re-run `otto-skills sync` (then `validate`), and review the lock diff. A changed upstream body fails revalidation (`otto-skills audit` flags drift) until you re-`validate`.
- **Roll back** by path: `git checkout` the files that pre-existed, then `rm` the new ones `git status` listed (`sync` writes one `.otto/skills/<skill-name>/` per imported skill). **Don't** `git clean -fd .otto/` — it deletes every untracked file there, your own hand-authored skills included.

## Verify a fresh repo

The P21 success criteria — a new repo enabling one profile passes the governance gates:

```bash
otto-extensions init coding-superpowers
otto-skills audit --external   # clean: pinned ref, no missing license/dup-name
otto-tools health              # clean: no tools (or headroom present for context-saver)
otto-eval compare <a> <b>      # smoke a recorded run pair
```
