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
- [x] `otto-linear-afk --project` flag + `--print-config` shows resolved scope
      (label + repo/project/team) via `describeScope`; watch poll lines name the
      exact scope. `parseFlags` captures raw `--project`; run-bin's
      `supportsProjectScope` (linear-only) builds a linear `WorkScope`
      (team+project), re-exports `OTTO_LINEAR_PROJECT` so the flag reaches the
      templates/poller, and threads `scope` into `runWatch`. `--project` on
      another bin errors. → verify: `pnpm -r typecheck && pnpm -r test && pnpm test`

## P2 — Artifact + branch naming restructure

- [x] Write **spec + plan** under `.otto/tasks/<task-key>/` (spec.md, plan.md)
      via `superpowers.md`, READING the legacy flat layout
      (`.otto/specs/<task-key>-design.md`, `.otto/plans/<task-key>.md`) as a
      fallback in the CLARITY GATE so in-flight tasks don't re-brainstorm.
      Template-driven (no otto code writes spec/plan); pinned by
      `superpowers-include.test.ts` (new write paths + legacy fallback). NOT
      migrating existing files: the currently-installed otto still reads the flat
      layout, so a move would break it — the legacy-read fallback handles
      migration on the next release instead. → verify: `pnpm -r typecheck && pnpm
      -r test && pnpm test`
- [ ] Adopt `.otto/tasks/<task-key>/` for the remaining artifacts
      (reviews/followups/quality-report/metadata). Needs the followups
      design call (the issue wants per-item task-local source but still globally
      summarizable) + a task-key source for `apply-review.md`, so it is its own
      task rather than folded into the spec/plan slice above.
- [ ] `--branch-convention` / `OTTO_BRANCH_CONVENTION` / `.otto/config.json`:
      branch = `<convention>/<task-key>`, default `otto`, validated + trailing-
      slash normalized; route through `resolveBranch`.
- [ ] Read legacy flat paths for the **remaining** artifacts
      (`.otto/review-followups.md`, `.otto/reviews/…`) as fallback for one
      release. (Spec/plan legacy-read already shipped with the first item.)

## P3 — Multi-target watch filters

- [ ] Repeatable `--repo` / `OTTO_GITHUB_REPOS` and `--project` /
      `OTTO_LINEAR_PROJECTS`: poll all scopes, run one loop for the scope with
      work, return to polling; one cumulative budget, cost reported per scope.

## P4 — Migration + docs

- [ ] Document old→new path mapping; optional migration command/steps; update
      README, CLI docs, architecture docs, quality-report samples.
