# issue-14 — otto-linear-afk (plan)

Ordered, bite-sized, testable tasks decomposing issue #14. One task per AFK run.
See `.otto/specs/issue-14-design.md` for problem/approach/assumptions. Built
incrementally on the `otto/14` branch; ships via PR (repo convention).

- [x] **Linear ref parsing.** Pure exported `parseLinearRef(raw)` in
      `packages/core/src/linear-api.ts` → discriminated `{ kind: "identifier" |
      "uuid", ... }`. Accept identifier `ENG-123`, issue UUID, and
      `linear.app/.../issue/ENG-123/...` URLs; uppercase the team key; reject
      empty / malformed / shell-metachar input. Tests:
      `linear-api.test.ts` mirroring `parseIssueRef` cases. Export from
      `index.ts`.
- [x] **Auth resolution.** Pure `resolveLinearAuth({ env, readFile })` →
      `{ token, source } | null` with precedence `OTTO_LINEAR_API_KEY` →
      `LINEAR_API_KEY` → `~/.config/otto/linear.json`. Injectable env/fs. Tests
      cover each precedence rung + missing.
- [x] **GraphQL client.** `linear-api.ts` narrow ops over injectable `fetch`:
      `listIssues`/`viewIssue`/`addComment`/`moveToDone`/`whoami`. Assert
      request shape (endpoint, `Authorization` header, query/vars) + response
      parsing against a mocked `fetch`. `createLinearClient({token,fetch})`
      returns single-request 1:1 ops; `LinearApiError` classifies failures
      `auth`/`request`/`network` (feeds watch-mode auth classification, task 8).
- [x] **`otto-linear-auth` bin + `runLinearAuth`.** `login`/`status`
      (`--verify-live`)/`logout`; writes `~/.config/otto/linear.json` `0600`
      outside the repo. Core `runLinearAuth(argv, deps)` pure-ish with injected
      fs/stdin; CLI bin is a thin wrapper. Tests on the core fn.
- [x] **Bundled `linear` helper CLI.** `list/dump/view/comment` parallel
      to `gh`; used by templates + agent. Thin layer over `linear-api.ts`
      (`runLinear(argv, deps)` core + `otto-linear` bin). `done` deferred to the
      completion-behaviour task below, which owns done-state resolution.
- [x] **Stages + templates.** `STAGES.linearImplementer` (`linearafk.md`),
      `STAGES.linearIssueImplementer` (`linearafk-issue.md`), playbook
      `linearprompt.md`; reuse reviewer. Render-contract smoke test +
      static-shell-tag invariant. `linearafk-issue.md` + `linearprompt.md` reuse
      the provider-agnostic `ghprompt-workflow.md` fragment (no fork).
- [ ] **`runLinearAfk` + run-bin wiring.** Parallel to `runGhAfk`: `mode:
      "linear"`, `--issue` via `parseLinearRef`, `--print-config` Linear-auth
      line, mutual-exclusion guards. Bin `apps/cli/bin/otto-linear-afk.js`.
- [ ] **Watch mode.** Provider-specific Linear polling (count/identifier/title
      only, default 300s) with idle/auth/error classification, reusing the
      `ghafk` watch UX. Test poll classification with an injected poller.
- [ ] **Completion behaviour + `linear done`.** PR repos → comment branch/PR
      info, leave open; commit-to-branch repos → move to done state
      (`OTTO_LINEAR_DONE_STATE` → first `type=completed` state; ambiguous →
      comment). Adds the `done` subcommand to the helper (done-state resolution)
      and encodes the decision in the playbook; test done-state resolution.
- [ ] **Docs.** README + `docs/CLI.md` mode table/recipes for the Linear mode;
      doc-contract test pins flags/stage names.
