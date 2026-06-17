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
- [x] Adopt `.otto/tasks/<task-key>/` for **follow-ups** (the only one of the
      four named artifacts actually persisted as a flat `.otto/` file today).
      `apply-review.md` now resolves a task key from the current git branch's
      final segment (it always runs on the task branch `<convention>/<slug>`,
      resolving the "no task-key source" blocker) and WRITES deferred findings to
      `.otto/tasks/<task-key>/followups.md`, beside the task's spec/plan — globally
      summarizable via the `.otto/tasks/*/followups.md` glob. The legacy global
      `.otto/review-followups.md` is still READ as a fallback for one release; new
      writes never go there. Template-driven (no otto code writes followups); pinned
      by `apply-review.test.ts`. **Deferred (not file-persisted today, so out of
      scope for this slice):** `reviews/` (panel writes verdicts to a temp
      `FINDINGS_DIR`, never `.otto/`), `quality-report` (emitted to the PR
      description / issue comment by the contract, not a file), and `metadata.json`
      (speculative — no producer/consumer exists; YAGNI). → verify: `pnpm -r
      typecheck && pnpm -r test && pnpm test`
- [x] `--branch-convention` / `OTTO_BRANCH_CONVENTION` / `.otto/config.json`:
      validated + trailing-slash-normalized branch namespace routed through
      `resolveBranch` (`normalizeBranchConvention`). The canonical, git-ref-safe
      replacement for the pre-existing raw `--branch-prefix` (kept as a
      back-compat fallback): precedence is flagConvention → flagPrefix →
      config.branchConvention → config.branchPrefix → `otto/`. `feat` and `feat/`
      both yield `feat/`; unsafe values throw. `--print-config` shows the
      convention. NOTE: the `<task-key>` half (swapping `slugify` for
      `deriveTaskKey`) stays with the deferred legacy-read task below — this item
      delivered the **convention namespace + validation** only. → verify:
      `pnpm -r typecheck && pnpm -r test && pnpm test`
- [x] Read legacy flat paths for the **remaining** artifacts as fallback for one
      release. `.otto/review-followups.md` is now READ-as-fallback by
      `apply-review.md` (shipped with the follow-ups slice above); new writes go
      task-local. `.otto/reviews/…` has no legacy reader to preserve — reviews were
      never persisted under `.otto/` (panel → temp `FINDINGS_DIR`), so there is
      nothing to fall back to. Spec/plan legacy-read shipped with the first P2 item.

## P3 — Multi-target watch filters

- [x] GitHub repeatable `--repo` / `OTTO_GITHUB_REPOS`: `parseFlags` accumulates
      repeated `--repo` into `flags.repos` (`repo` kept = first); run-bin merges
      with the comma-list `OTTO_GITHUB_REPOS` into a github `WorkScope[]` (single
      entry → unchanged single-target path + `OTTO_GITHUB_REPO` export; >1 →
      `scopes` passed to `runWatch`, none pinned). `runWatch` polls every scope
      each cycle, runs ONE loop for the first scope with work (pinning
      `OTTO_GITHUB_REPO` to it so the templates/agent are confined), then returns
      to polling; a failed poll for one scope is logged and skipped (never blocks
      the others); one cumulative budget; each poll/run line names its scope via
      `describeScope`; `--print-config` lists all scopes. → verify: `pnpm -r
      typecheck && pnpm -r test && pnpm test`
- [x] Linear repeatable `--project` / `OTTO_LINEAR_PROJECTS` (mirror the GitHub
      half): `parseFlags` accumulates repeated `--project` into `flags.projects`
      (`project` kept = first); run-bin merges with the comma-list
      `OTTO_LINEAR_PROJECTS` into a linear `WorkScope[]` (single → unchanged
      single-target path + `OTTO_LINEAR_PROJECT` export; >1 → `scopes`). The
      Linear poller reads the project from the env (not a poll arg), so
      `runWatch` pins `OTTO_LINEAR_PROJECT` before polling each scope (confining
      the poll AND the loop); one loop per cycle for the first scope with work;
      failed polls skipped; one cumulative budget; each poll line names its scope
      via `describeScope`; `--print-config` lists all scopes. → verify: `pnpm -r
      typecheck && pnpm -r test && pnpm test`

## P4 — Migration + docs

- [x] Document old→new path mapping; optional migration command/steps; update
      README, CLI docs, architecture docs, quality-report samples. Shipped
      `docs/MIGRATION.md` (task-grouped layout, old→new mapping table,
      legacy-read compat guarantee, **documented manual migration** — no CLI
      command, YAGNI since legacy-read covers a release, branch-convention
      namespace, "everything Otto knows" task-dir answer), drift-pinned by
      `scripts/migration-doc-contract.test.mjs` (new paths anchored to the live
      `superpowers.md`/`apply-review.md` templates). Documented
      `--branch-convention`/`OTTO_BRANCH_CONVENTION` in CONFIG.md; added
      MIGRATION.md to the README doc index; updated the apply-review follow-up
      path in README/CLI.md/ARCHITECTURE.md/quality-report-samples.md to the
      task-local `.otto/tasks/<task-key>/followups.md`. → verify: `pnpm -r
      typecheck && pnpm -r test && pnpm test`
