# issue-21 — Otto Watch Scope And Naming

## Problem

Issue #21 is a roadmap with five priorities:

- **P0** Work scope + task key contract — one internal model for *where work came
  from* and one stable naming key for artifacts/branches.
- **P1** Single-target watch filters (`--repo` / `--project`).
- **P2** Artifact + branch naming restructure (`.otto/tasks/<task-key>/…`,
  `<branch-convention>/<task-key>`).
- **P3** Multi-target watch filters (repeatable `--repo` / `--project`).
- **P4** Migration + docs.

P0 is the shared dependency for everything else: scoped watch, branch naming, and
artifact storage all key off a normalized task key derived from a work source.

## Approach

Build the roadmap in the issue's own recommended order, one bite-sized + tested
task per plan item (see `.otto/plans/issue-21.md`). Each task ships independently;
this run implements **only the first** (P0 helper module), per the single-task rule.

### This run: P0 — work scope + task key contract

A new pure module `packages/core/src/task-key.ts` exporting two related concepts
the issue frames together as "work scope + task key":

- `WorkScope` — *where* Otto may look for work (used later by watch + `--print-config`):
  - `{ provider: "plan" }`
  - `{ provider: "github"; owner?; repo? }`
  - `{ provider: "linear"; team?; project? }`
- `WorkSource` — a scope **plus the specific item** (used to name artifacts/branches):
  - `{ provider: "plan"; slug }`
  - `{ provider: "github"; owner?; repo?; issue: number; slug? }`
  - `{ provider: "linear"; team?; project?; issue: string; slug? }`

Functions:

- `deriveTaskKey(source: WorkSource): string` — normalized, **filesystem-safe and
  git-branch-safe** key. Shapes (per the issue):
  - `plan-<slug>`
  - `gh-<owner>-<repo>-<issue>[-<slug>]` (owner/repo omitted when absent → `gh-<issue>[-<slug>]`)
  - `linear-<team>-<project>-<issue>[-<slug>]` (each optional part omitted when absent)
- `describeScope(scope: WorkScope): string` — human-readable scope line for
  `--print-config` and watch logs (e.g. `github owner/name`,
  `linear team:ENG project:Roadmap Q3`, `plan (local workspace)`).

Every free-text component is sanitized with the same rule as `slugify`
(lowercase, non-`[a-z0-9]` → `-`, trim dashes), guaranteeing `[a-z0-9-]` only —
which is both filesystem-safe and git-branch-safe. Free-text slugs are capped at
40 chars (matching `slugify`); structural parts (issue numbers/ids) pass through
sanitized.

Exported from `packages/core/src/index.ts`. **Nothing is wired into the run path
this round** — deriving the key replaces today's `issue-<n>` task-key, and that
swap needs the legacy-path fallback from P2/P4, so it is a later plan task. The
P0 helper is inert until then, so it cannot regress existing behavior.

## Assumptions

- **Which single task?** → *P0 helper module + tests* → It is build-order step 1
  and the shared dependency; the single-task rule forbids doing P1–P4 too.
- **New task-key format vs. existing `issue-<n>`?** → *helper emits the new
  canonical format; existing runtime paths untouched this round* → "Existing
  behavior remains the default" refers to runtime; swapping the path generation
  needs legacy fallback (P2/P4), so P0 only adds the inert helper.
- **`owner`/`repo`/`team`/`project` optional?** → *yes, omitted parts drop out of
  the key* → preserves a sensible default key (`gh-<issue>`) when no scope is
  given, matching "default when no scope provided".
- **Two types (scope + source) vs. one?** → *two* → the issue explicitly frames
  scope (where, for watch/print-config, no item) and task key (where + item) as
  distinct; watch polls before any item exists, so a scope without an item is real.
- **Branch-safety proof?** → *assert the derived key passes `git check-ref-format`*
  → the issue requires keys be git-branch-safe; test it against real git rather
  than asserting a regex.

## Testing

`packages/core/src/__tests__/task-key.test.ts` (vitest):

- `deriveTaskKey` shape per provider, with and without optional parts.
- Sanitization: uppercase, spaces, slashes, punctuation → `[a-z0-9-]`; slug cap.
- Branch-safety: derived keys (incl. `otto/<key>`) pass `git check-ref-format`.
- Filesystem-safety: no `/` or path-traversal in the key.
- `describeScope` lines per provider, with/without optional parts.

Feedback loops: `pnpm -r typecheck && pnpm -r test && pnpm test`.
