# Extension profiles

Curated, lockable bundles that combine the Phase-4 primitives — skill sources (P16), the validation gate (P17), runtime activation (P18), and the tool-authority layer (P19/P20) — into one opinionated starting point for a common job.

`otto-extensions init <profile>` writes **normal, inspectable config** — the same files you could write by hand:

- `.otto/skills/sources.json` — registered (pinned) skill sources
- `.otto/tools/<name>.json` — tool adapters
- `.otto/config.json` — activation / compressor defaults
- `.otto/policy.json` — safety-policy additions (union-merged, never relaxed)

A profile is **generated config, not hidden behavior**: inspect it, edit it, diff it, roll it back. Enabling a profile does **not** auto-trust anything — a registered source is still imported `unverified` and must clear the P17 gate before P18 will inject it; a tool is still policy-scoped.

> Want a from-scratch, per-pack walkthrough (Superpowers, Product-Manager-Skills, a single Cursor skill, Headroom) — clone → register → validate → activate, with the gotchas? See **[INTEGRATIONS.md](./INTEGRATIONS.md)**.

```bash
otto-extensions list                       # show the curated profiles
otto-extensions init context-saver --dry-run   # preview every file it would write
otto-extensions init context-saver         # write it
git diff .otto/                            # review exactly what changed
```

## Profiles

| Profile              | Writes                                                              | For                                                                   |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `coding-superpowers` | `superpowers` source (pinned) + `skills.{enabled,implement,review}` | Superpowers coding methodology on the implement + review stages.      |
| `pm-planning`        | `pm-skills` source (pinned) + `skills.{enabled,plan,report}`        | PM frameworks (roadmap, prioritization, PRD, framing) on plan/report. |
| `context-saver`      | `headroom` tool + `contextCompressor: "headroom"`                   | Local-first token compression with P7 context-report defaults.        |
| `security-review`    | `skills.{enabled,review}` + stricter `.otto/policy.json`            | Security/structural review posture + tighter governance.              |

## Compatibility matrix

| Profile              | Source / tool                                  | Pinned ref | Required local binaries | Tested Otto | Known limits                                                                                             |
| -------------------- | ---------------------------------------------- | ---------- | ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `coding-superpowers` | `github.com/obra/superpowers` (git)            | `v6.0.3`   | `git`                   | 0.x         | Git source `sync` is not implemented yet (P16 starts local) — vendor locally or wait for git fetch.      |
| `pm-planning`        | `github.com/deanpeters/Product-Manager-Skills` | `v1.0.0`   | `git`                   | 0.x         | Same git-`sync` limitation; PM skills classify `stage-scoped` to plan/report.                            |
| `context-saver`      | `headroom` (command tool)                      | n/a        | `headroom`              | 0.x         | `otto-tools health` fails until the `headroom` binary is installed; the run degrades cleanly without it. |
| `security-review`    | policy only                                    | n/a        | none                    | 0.x         | Pairs with `--review-panel`; review the generated `.otto/policy.json` and tighten further.               |

> The pinned refs live in one place (`extension-profiles.ts`) so this matrix and the manifests cannot drift. Until git-source `sync` lands, register the source then point it at a local checkout (`otto-skills sources add <name> <path> --type local`) to import.

## After `init`: validate, then activate

A profile registers sources and turns activation **on in config**, but skills still pass through the P17 gate before P18 injects them:

```bash
otto-extensions init coding-superpowers
otto-skills sync                      # import the source's skills (unverified)
otto-skills validate <skill>          # gate → afk-safe | interactive-only | stage-scoped | blocked
otto-afk --use-skills "./plan.md" 10  # only validated, eligible skills are injected
```

For `context-saver`, install the binary and confirm it resolves:

```bash
otto-extensions init context-saver
otto-tools health                     # runs the LITERAL `headroom --version` — ignores
#                                       OTTO_HEADROOM_BIN (#192), so it can disagree with a run
otto-afk "./plan.md" 10               # the compressor is now the config default
```

The `.otto/tools/headroom.json` entry is an **inspection/health** surface. The runtime enables the compressor straight from the `contextCompressor` config — it is **not** gated per-stage through tool policy ([#192](https://github.com/phamvuhoang/otto/issues/192)).

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
