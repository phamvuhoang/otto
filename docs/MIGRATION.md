# Artifact & branch naming migration

Otto used to scatter its per-task artifacts by **type** (`.otto/specs/`,
`.otto/plans/`, `.otto/review-followups.md`). It now groups them by **task** in a
single directory keyed by a stable **task key**, so everything Otto knows about
one piece of work lives in one place. Branches use the same task key under a
user-selectable convention namespace.

This page documents the old→new mapping, the compatibility guarantee, and how to
migrate an existing repo by hand. For the full env/flag reference see
**[CONFIG.md](./CONFIG.md)** and **[CLI.md](./CLI.md)**.

- [Task-grouped layout](#task-grouped-layout)
- [Old → new path mapping](#old--new-path-mapping)
- [Compatibility (legacy-read) guarantee](#compatibility-legacy-read-guarantee)
- [Branch convention namespace](#branch-convention-namespace)
- [Migrating an existing repo](#migrating-an-existing-repo)
- [Finding everything Otto knows about a task](#finding-everything-otto-knows-about-a-task)

---

## Task-grouped layout

Each task's artifacts now live together under `.otto/tasks/<task-key>/`:

```text
.otto/tasks/<task-key>/
  spec.md         # brainstorm/design output
  plan.md         # ordered task checklist
  followups.md    # deferred review findings for this task
```

`<task-key>` is the normalized, filesystem- and git-branch-safe key Otto derives
for the work (e.g. `issue-21`, `plan-feature`, `gh-owner-repo-14-linear-afk`).

Durable, repo-global files are unchanged — they are **not** per-task and stay at
the top of `.otto/`:

```text
.otto/LEARNINGS.md   # accumulated conventions/gotchas/decisions
.otto/config.json    # resolved repo config (branch strategy, etc.)
.otto/verdicts.md    # human verdict trail
```

## Old → new path mapping

| Old (flat, by type)         | New (grouped, by task)                  |
| --------------------------- | --------------------------------------- |
| `.otto/specs/<task-key>-design.md` | `.otto/tasks/<task-key>/spec.md`  |
| `.otto/plans/<task-key>.md` | `.otto/tasks/<task-key>/plan.md`        |
| `.otto/review-followups.md` (one global file) | `.otto/tasks/<task-key>/followups.md` (one per task) |

Reviews were never persisted under `.otto/` (the review panel writes verdicts to
a temporary findings dir), and the quality report is emitted into the PR
description / issue comment by the completion handoff — neither is a flat
`.otto/` file, so neither moves.

## Compatibility (legacy-read) guarantee

You do **not** have to migrate anything for Otto to keep working. New runs
**write** the task-grouped layout, but Otto still **reads** the old flat paths as
a fallback for at least **one release**:

- The clarity gate checks `.otto/tasks/<task-key>/spec.md` first, then falls back
  to the legacy `.otto/specs/<task-key>-design.md`, so an in-flight roadmap
  started under the old layout continues without re-brainstorming.
- `apply-review` reads `.otto/tasks/<task-key>/followups.md` first, then the
  legacy global `.otto/review-followups.md` — but new follow-ups are only ever
  appended to the task-local file.

This is why Otto does **not** auto-migrate your existing files: the
currently-installed Otto driving a live run still reads the old layout, so moving
files mid-run could strand a roadmap. The legacy-read does the migration safely on
the next release; the manual steps below are optional cleanup.

## Branch convention namespace

Generated branch names use the same task key under a validated namespace:

```text
<branch-convention>/<task-key>
```

The convention defaults to `otto` and is overridable by flag, env var, or
`.otto/config.json`:

```bash
otto-afk --branch-convention feat "./docs/plans/feature.md" 10
otto-ghafk --branch-convention feature --issue 42 5
OTTO_BRANCH_CONVENTION=fix otto-linear-afk --issue ENG-123 5
```

Validation normalizes an optional trailing slash (`feat` and `feat/` both yield
`feat/`) and rejects git-ref-unsafe values. `--branch-convention` is the
canonical replacement for the older raw `--branch-prefix` (still accepted for
back-compat); precedence is `--branch-convention` → `--branch-prefix` →
`config.branchConvention` → `config.branchPrefix` → `otto/`. See
[CONFIG.md → Branch strategy](./CONFIG.md#branch-strategy).

## Migrating an existing repo

Manual migration is **optional** (the legacy-read covers you for a release). To
tidy an existing repo into the new layout, move each task's files into its task
directory. For a task key `issue-21`:

```bash
mkdir -p .otto/tasks/issue-21
git mv .otto/specs/issue-21-design.md .otto/tasks/issue-21/spec.md
git mv .otto/plans/issue-21.md        .otto/tasks/issue-21/plan.md
```

For the global follow-ups file, split it per task (or simply leave it — it stays
readable as a fallback). Once every task is moved you can drop the now-empty
`.otto/specs/` and `.otto/plans/` directories. Commit the moves with your normal
workflow; nothing else needs to change.

## Finding everything Otto knows about a task

Because artifacts are grouped by task, **everything Otto knows** about a piece of
work is one directory listing:

```bash
ls .otto/tasks/<task-key>/        # spec.md, plan.md, followups.md
cat .otto/tasks/<task-key>/spec.md
```

To summarize deferred follow-ups across **all** tasks, glob the task-local files:

```bash
cat .otto/tasks/*/followups.md
```
