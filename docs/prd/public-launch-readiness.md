# PRD: Public launch readiness

## Problem Statement

Otto is a working, npm-published project (`@phamvuhoang/otto` / `@phamvuhoang/otto-core` are public on npm), but the **GitHub repository is still private**. The maintainer wants to flip the repository public — likely tied to an article-serial launch — and needs confidence that doing so is safe, that the release pipeline actually works, and that the first impression is clean.

A pre-launch review surfaced one systemic defect and several smaller hygiene issues:

- **The 0.6.3 release is half-completed.** Git and GitHub are at 0.6.3 (commits, tags `otto-core-v0.6.3` / `otto-v0.6.3` / `otto-sandbox-v0.2.3`, and GitHub Releases all exist), but **npm is stuck at 0.6.2 and the sandbox image at 0.2.2**. Users installing from npm do not get the 0.6.3 fixes (notably the ghafk silent-issue-fetch-failure fix).
- **Root cause: the `RELEASE_PLEASE_TOKEN` secret does not exist.** The repo has only `DOCKERHUB_TOKEN`, `DOCKERHUB_USERNAME`, and `NPM_TOKEN`. release-please therefore falls back to `GITHUB_TOKEN`, and tags created with `GITHUB_TOKEN` do **not** raise `push: tags` events — so `publish-npm.yml` and `publish-image.yml` never fired. **Every future release will half-complete the same way** until a PAT is added. A `release-please` run also failed on 2026-06-05, which killed the sandbox image-publish dispatch step in the same run.
- **An earlier manual edit poisoned release-please.** A hand-edit of `.release-please-manifest.json` + both `package.json` files (commit `ea1c006`, "bump to 0.6.3") triggered a cascade of phantom versions (0.6.0, 0.6.3) and revert churn visible in the changelog/history.
- **CI actions are about to break.** GitHub forces Node-20 actions to Node 24 on **2026-06-16**. The repo pins `actions/checkout@v4`, `actions/setup-node@v4`, and `pnpm/action-setup@v4` (all Node 20), and the dependabot PRs that would bump them (#54–#57) were closed unmerged.
- **The repo surface is cluttered.** Going public exposes 12 remote branches (5 merged, several stale dependabot/feature branches) and one open dependabot PR (#66) whose CI is red because a dev-dependency bump breaks the `@types/node`-dependent build.

Everything else reviewed cleanly: a full git-history secret scan found zero tokens/keys; the README leads with a prominent security warning about `bypassPermissions` + the root-equivalent Docker-socket mount; `main` CI is green; typecheck + all tests pass (17 root, 59 core); and README install commands are unpinned so they will not go stale after the publish.

## Solution

Treat the launch as a short, ordered, **de-risked runbook** rather than a code change. The guiding decision is to **roll the half-completed 0.6.3 release forward** (make the registries match what git/GitHub already claim) instead of rolling back — rolling back would fight already-published GitHub Releases and discard real release artifacts.

The runbook, in dependency order:

1. **Fix the root cause** — add a repo-scoped Personal Access Token as the `RELEASE_PLEASE_TOKEN` secret so release-please-created tags trigger the publish workflows on every future release.
2. **Roll the 0.6.3 release forward** — manually dispatch the existing publish workflows (which already expose `workflow_dispatch` with a `tag` input) to publish `@phamvuhoang/otto-core@0.6.3`, `@phamvuhoang/otto@0.6.3`, and the `otto-sandbox:0.2.3` image, enriching the existing GitHub Releases with their `.tgz` / SBOM / cosign artifacts.
3. **Modernize CI actions** — bump the Node-20 actions to current majors ahead of the June 16 deadline, as a separate change so an action-version surprise cannot break the launch publish.
4. **Clean the repo surface** — delete merged and stale branches, close the red dependabot PR.
5. **Flip the repository public.**

The `RELEASE_PLEASE_TOKEN` fix plus a documented "never hand-edit release-please-owned version files" rule together make releases reliable going forward, so this launch is the last one that needs a manual roll-forward.

## User Stories

1. As the maintainer, I want the GitHub repository made public, so that I can link it from the article serial and accept external contributions.
2. As the maintainer, I want assurance that no secret was ever committed before flipping public, so that making the full git history world-readable is safe.
3. As an npm user, I want `@phamvuhoang/otto@latest` to install 0.6.3, so that I receive the ghafk silent-failure fix and other 0.6.3 changes.
4. As an operator, I want `docker.io/phamvuhoang/otto-sandbox:latest` to serve the 0.2.3 image, so that my loop runs the current playbooks.
5. As a security-conscious user, I want the existing 0.6.3 GitHub Releases enriched with their `.tgz`, SBOM, and cosign attestation, so that the supply-chain artifacts match the published versions.
6. As the maintainer, I want a `RELEASE_PLEASE_TOKEN` PAT configured, so that release-please-created tags trigger the npm and image publish workflows automatically.
7. As the maintainer, I want every future release to publish all three artifacts without a manual dispatch, so that releases stop half-completing.
8. As the maintainer, I want to never hand-edit `.release-please-manifest.json` or the `package.json` version fields, so that I do not re-trigger phantom-version churn.
9. As the maintainer, I want the half-completed 0.6.3 reconciled by rolling forward rather than back, so that already-published GitHub Releases and tags are honored, not destroyed.
10. As a contributor, I want CI to keep working after the June 16 Node-24 cutover, so that pull-request checks do not start failing on infrastructure deprecation.
11. As the maintainer, I want the release/publish workflows to keep running after June 16, so that the next release is not blocked by a runner-deprecation failure.
12. As the maintainer, I want the CI-action bump kept separate from the 0.6.3 publish, so that a breaking action major (the dependabot action bumps were closed unmerged once already) cannot break the launch publish.
13. As a visitor landing on the public repo, I want a tidy branch list, so that the project reads as maintained.
14. As the maintainer, I want merged branches (`feat/global-cli-install`, `fix/ghafk-silent-issue-fetch-failure`, `fix/release-please-manifest-anchor`, `fix/result-grace-timer`, `release/release-v0.6.2`) deleted, so that they do not clutter the public branch list.
15. As the maintainer, I want the stale `feature/release` branch (superseded, last touched 2026-05-20) deleted, so that abandoned early work is not mistaken for live work.
16. As the maintainer, I want stale closed-PR dependabot branches removed, so that only live branches remain.
17. As the maintainer, I want the red dependabot PR #66 closed, so that a failing dev-dependency bump is not the first PR a visitor sees.
18. As a new visitor, I want the README to lead with the `bypassPermissions` + Docker-socket security warning, so that I understand the blast radius before running an AFK loop. (Already satisfied; verified in scope.)
19. As a new user, I want install commands that resolve to the current published version without me editing a pin, so that copy-paste works after the publish. (Already satisfied; unpinned commands.)
20. As an interested reader, I want the internal `docs/plans` and `docs/prd` design docs to remain in the public repo, so that I can see the engineering rationale.
21. As the maintainer, I want a documented verification step after the roll-forward (`npm view @phamvuhoang/otto version` returns 0.6.3, image digest present on the release), so that I can confirm the registries are consistent before flipping public.
22. As a future maintainer, I want this whole episode captured as a PRD, so that the next person understands why 0.6.3 was rolled forward and why the PAT matters.

## Implementation Decisions

### Reconciliation strategy

- **Roll forward, not back.** GitHub already has 0.6.3 tags and Releases; the registries lag. Rolling forward publishes the lagging artifacts; rolling back would delete real releases and re-run the same race.
- Roll-forward uses the **existing `workflow_dispatch` escape hatches** already present in `publish-npm.yml` (`tag` input) and `publish-image.yml` (`tag` / `also_latest` / `release_tag` inputs). No workflow code change is required to roll forward.
- npm: dispatch `publish-npm.yml` twice — once for `otto-core-v0.6.3`, once for `otto-v0.6.3`. The workflow checks out the tag (where `package.json` is already 0.6.3) and publishes.
- image: dispatch `publish-image.yml` with `tag=v0.2.3`, `also_latest=true`, `release_tag=otto-sandbox-v0.2.3` so `:latest` advances and the existing Release is enriched.

### Root-cause fix

- Add a repo secret `RELEASE_PLEASE_TOKEN` — a classic PAT with `repo` scope, or a fine-grained PAT with contents + actions + pull-requests write. This is a maintainer action (a token cannot be created by the agent).
- Adopt the rule: **release-please owns `.release-please-manifest.json` and the per-package `version` fields**; they are never hand-edited. The manual bump in `ea1c006` is the documented cause of the phantom-version churn.

### CI action modernization (separate change)

- Bump, across `ci.yml`, `publish-npm.yml`, `publish-image.yml`, `release-please.yml`:
  - `actions/checkout` v4 → v5
  - `actions/setup-node` v4 → v6
  - `pnpm/action-setup` v4 → v6
  - `docker/login-action` v3 → v4
  - `JS-DevTools/npm-publish` v3 → v4
- Landed as its own PR, CI confirmed green before merge, and **decoupled from the 0.6.3 roll-forward** so a v6 behavior change cannot break the launch publish. The current (v4) actions still function until June 16, so the roll-forward can run on them first.
- Actions already on a Node-24-compatible runtime (docker/setup-qemu, setup-buildx, build-push-action@v6, cosign-installer, sbom-action, release-please-action@v4) are left unchanged.

### Repo hygiene

- Delete the 5 merged branches and the stale `feature/release` branch; delete the stale closed-PR dependabot branches. Leave the live dependabot branch for PR #66 only as long as #66 is open.
- Close PR #66. Its failure (`stream-render.ts: TS2591 Cannot find name 'process'`) comes from the dev-dependency bump changing `@types/node` resolution; `main` is green, so this is branch-only. A latent observation — `tsconfig` lacks an explicit `"types"` field and is therefore fragile to `@types/node` changes — is recorded but not fixed in this PRD.
- Keep `docs/plans` and `docs/prd` in the public tree; they document process and are already framed as historical/internal by their READMEs.

### Sequencing

Phase 0 (maintainer): add the PAT. Phase 1: roll forward 0.6.3 on current actions; verify. Phase 2: bump CI actions via PR. Phase 3: branch + PR cleanup. Phase 4 (maintainer): flip repository public. Phases 0–3 can overlap; only Phase 4 strictly depends on the rest.

## Testing Decisions

A good test here verifies **external, observable outcomes** — which version each registry serves, which artifacts hang off each Release — not the internals of release-please or GitHub Actions. Most of this work is one-time operational reconciliation and is verified by direct observation, not by an automated suite.

Verification steps (manual, post-action):

- After roll-forward: `npm view @phamvuhoang/otto version` and `npm view @phamvuhoang/otto-core version` both return `0.6.3`; the `otto-sandbox:0.2.3` image exists and `:latest` points at it; the three 0.6.3/0.2.3 GitHub Releases carry their `.tgz` / SBOM / cosign artifacts.
- After the action bump: the CI workflow run on the bump PR is green before merge.
- After hygiene: the public branch list shows only `main` plus any genuinely live branch; PR #66 is closed.
- After the PAT is added: the next routine release (the first `feat:`/`fix:` after 0.6.3) publishes npm + image automatically with no manual dispatch — the real regression test for the root-cause fix.

The one durable, automatable invariant worth a guard is **"registries are not behind git."** A small check that compares the latest `otto-core-v*` / `otto-v*` tag against `npm view <pkg> version` (and the latest `otto-sandbox-v*` tag against the published image tag) and fails when the registry lags would catch a future half-completed release immediately. Prior art exists in the repo for this style of pure-logic test: `scripts/release-please-config.test.mjs` and `scripts/update-status-table.test.mjs` run under `node --test`, and `scripts/runner-floating-ref.test.mjs` already reasons about tag/ref state. A new `node --test` script in that family is the right home; the comparison core should be a pure function (tags + registry versions in → list of lagging components out) so it is testable without network calls, with the live lookups injected at the edge.

## Out of Scope

- **Fixing the `tsconfig` `@types/node` fragility** that makes PR #66 red. Noted as latent tech-debt; `main` is unaffected, so it is not part of the launch.
- **Re-enabling npm OIDC provenance, multi-arch images, or GPG-signing npm packages.** These were deliberately dropped earlier and are separate decisions (see the release-management PRD).
- **Any change to the README, SECURITY.md, or QUICKSTART content.** The security framing and install docs were reviewed and judged adequate as-is.
- **Rewriting the release workflows.** The roll-forward uses their existing `workflow_dispatch` hooks; only the action `uses:` versions change, in a separate PR.
- **Rebasing/merging dependabot PR #66's dependency changes.** The PR is closed, not fixed.
- **A launch announcement, the article-serial content, or the canonical-fact linter.** Tracked separately.
- **Squashing or rewriting the phantom-version history** in the changelog/git. The history is left as-is; only the registries are reconciled forward.

## Further Notes

- The single most important durable outcome is the `RELEASE_PLEASE_TOKEN` secret. Without it the project ships a release pipeline that silently half-completes on every release; with it, the roll-forward in this PRD is the last manual publish needed.
- The decision to roll forward rather than back hinges on the fact that the GitHub Releases for 0.6.3 / 0.2.3 already exist and `otto: v0.6.3` is marked Latest. Reconciling toward what git already asserts is less destructive than unwinding it.
- The CI-action bump is intentionally **not** bundled with the publish. The action-version dependabot PRs (#54–#57) were closed unmerged once already, so the v5/v6 majors are treated as a non-trivial change that must prove itself in CI before the launch depends on it. The Node-24 forced cutover (June 16) sets the deadline, not the launch.
- A full git-history secret scan (tokens, PATs, npm/AWS keys, private keys, `.env`/credential files, hardcoded workflow secrets) returned clean; this is the gating safety check for private→public and is recorded here as having passed at review time.
- Relevant context for a future maintainer is also captured in the session memory note `release-pipeline-token-gap`, including the exact roll-forward dispatch commands.
