# issue-8 — Improve Maintainer Workflows (plan)

Ordered, bite-sized, testable tasks decomposing issue #8. One task per AFK run.
See `.otto/specs/issue-8-design.md` for problem/approach/assumptions.

- [x] **Next-action hint in end-of-run summary.** Add pure exported
      `nextActionFor(reason)` and append a `→ next: <hint>` line (stdout,
      `dimOut`) inside `summarize` in `loop.ts`. Tests: unit per reason +
      integration on `complete` / `stopped (budget)` / `done with failures`.
- [x] **Mode comparison table in docs.** A table in `docs/CLI.md` (and a
      pointer from README) comparing `otto-afk`, `otto-ghafk`, `--verify`,
      `--apply-review`: input, gate stage, when to use. Success signal: choose a
      mode without reading source.
- [x] **Worked recipes.** Three end-to-end recipes in `docs/CLI.md`: issue
      burn-down, external-review repair, overnight run — each a copy-pasteable
      command block + what the end-state summary looks like.
- [ ] **Clearer watch-mode empty-queue & auth-failure output.** Distinguish "0
      open issues" (idle) from "gh poll failed / not authed" in `watch.ts`
      instead of collapsing both to "treating as no work". Test in `watch.test.ts`.
- [ ] **apply-review follow-up-trail test.** Cover that deferred findings land
      in `.otto/review-followups.md` and are committed with the fix (currently
      only flag-parsing is tested).
- [ ] **Deferred-work count in summary (optional).** If cheap, surface a count
      of open `.otto/review-followups.md` entries in the end-of-run summary.
