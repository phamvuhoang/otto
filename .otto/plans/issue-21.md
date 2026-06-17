# issue-21 plan — Otto Watch Scope And Naming

One bite-sized, tested task per item, in the issue's recommended build order.
This run implements **only the first unchecked task**.

## P0 — Work scope + task key contract

- [x] Add `task-key.ts` with `WorkScope` / `WorkSource` types, `deriveTaskKey`
      (fs-safe + git-branch-safe), and `describeScope`; export from `index.ts`;
      unit tests (shape, sanitization, branch-safety via `git check-ref-format`).
      → verify: `pnpm -r typecheck && pnpm -r test`

## P1 — Single-target watch filters

- [x] GitHub `--repo owner/name` / `OTTO_GITHUB_REPO`: `parseGithubRepo` →
      `WorkScope`; threaded into `pollOpenIssues` (`gh issue list --repo`), the
      ghafk list/view templates (`${OTTO_GITHUB_REPO:+--repo …}`), the completion
      prose, and `--print-config`/watch poll lines via `describeScope`. Gated to
      otto-ghafk; invalid scope is fatal for a real run, reported (exit 0) under
      `--print-config`. → verify: `pnpm -r typecheck && pnpm -r test && pnpm test`
- [x] Linear `OTTO_LINEAR_PROJECT` / `otto-linear --project`: `listIssues` adds a
      `project: { name: { eq } }` filter; `otto-linear list`/`dump` resolve project
      from `--project`/`OTTO_LINEAR_PROJECT`; `pollLinearIssues` + the linear-afk
      `watchPoll` thread it (env inherited by the templates, like team). The
      `otto-linear-afk --project` flag + print-config scope display is the next item.
- [ ] `--print-config` shows resolved scope (label + repo/project/team) via
      `describeScope`; watch poll lines name the exact scope.

## P2 — Artifact + branch naming restructure

- [ ] Write new artifacts under `.otto/tasks/<task-key>/` (spec/plan/reviews/
      followups/quality-report/metadata) using `deriveTaskKey`.
- [ ] `--branch-convention` / `OTTO_BRANCH_CONVENTION` / `.otto/config.json`:
      branch = `<convention>/<task-key>`, default `otto`, validated + trailing-
      slash normalized; route through `resolveBranch`.
- [ ] Read legacy flat paths (`.otto/specs/…`, `.otto/plans/…`,
      `.otto/review-followups.md`) as fallback for one release.

## P3 — Multi-target watch filters

- [ ] Repeatable `--repo` / `OTTO_GITHUB_REPOS` and `--project` /
      `OTTO_LINEAR_PROJECTS`: poll all scopes, run one loop for the scope with
      work, return to polling; one cumulative budget, cost reported per scope.

## P4 — Migration + docs

- [ ] Document old→new path mapping; optional migration command/steps; update
      README, CLI docs, architecture docs, quality-report samples.
