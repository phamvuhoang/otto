# issue-19 — Otto Quality Verification Roadmap (plan)

Ordered, bite-sized, testable tasks decomposing issue #19. One task per AFK run.
See `.otto/specs/issue-19-design.md` for problem/approach/assumptions. Built
incrementally on the `otto/19` branch; ships via PR (repo convention).

## Feature 1 — Standardize the quality report

- [x] **Quality report contract fragment.** New includable
      `packages/core/templates/quality-report.md` capturing the report contract
      (Verdict / Task Source / What Changed / Evidence / Human Acceptance
      Checklist / Gaps And Follow-Ups). Verdict vocabulary = Accepted · Accepted
      with follow-ups · Needs human review · Rejected, defaulting to *Needs
      human review* when uncertain; tests are evidence, not the verdict. Adopt it
      in `verify.md` via `@include:quality-report.md`, replacing the ad-hoc
      report block while keeping the read-only / `.otto-tmp/verify-report.md`
      guardrails. Render-contract tests pin the fragment's sections + the include.
- [x] **Parity: ghafk completion summary.** `ghprompt-workflow.md` FINISHING
      section instructs the agent to emit the quality-report contract (via
      `@include:quality-report.md`) into the PR body / issue comment, with
      GitHub-specific links. Render-contract test pins the include + GitHub link
      prose. Done: the include lives in the *shared* workflow fragment, so the
      report shape reaches every `*afk*` mode through one include (drift-proof);
      Linear's next task only overrides placement, not shape — no second include.
- [x] **Parity: linear completion summary.** `linear-completion.md` overrides
      *placement* — the Linear comment body IS the quality report (verdict,
      branch/PR, evidence, checks, human next step), respecting "PR-based repos
      leave the issue open". It does NOT re-include the fragment (the shape comes
      once from the shared `ghprompt-workflow.md` FINISHING include); the Linear
      single-issue chain already resolves the six contract sections end-to-end.
      Render-contract tests pin the placement prose, the no-double-include
      invariant, and the end-to-end sections.
- [ ] **Parity: apply-review report.** `apply-review.md` emits the contract
      summarizing the review-fix round (CONFIRMED fixed, REJECTED, deferred).
      Render-contract test.

## Feature 2 — Human acceptance playbooks

- [ ] **Per-mode acceptance prompts.** Mode-specific acceptance-check question
      sets (plan/PRD, GitHub burn-down, Linear burn-down, external review repair,
      read-only verify) folded into the checklist section of the contract or a
      sibling fragment. Render-contract test pins each mode's prompts.
- [ ] **Task-fulfillment review lens.** Add a `task-fit` lens to the review panel
      (`review-lens.md` is lens-parametric) focused on "did Otto solve the right
      problem / is it reviewer-useful", separate from correctness/security/tests.
      Test the lens wiring + default lens set unchanged.
- [ ] **Sample verification transcripts.** Add `docs/` sample quality reports for
      a few realistic runs so users know what good output looks like. Doc-contract
      test pins their presence + required sections.

## Feature 3 — Close the feedback loop

- [ ] **Human-verdict trail.** A lightweight `.otto/quality/` (or
      `.otto/verdicts.md`) trail the playbooks surface + append (accepted /
      accepted-with-follow-ups / rejected / needs-investigation + why), feeding
      the existing learnings loop. Template-driven, render-contract tested like
      the review-followups trail.
- [ ] **Cross-run quality summary.** A read-only command/section summarizing
      completion count, gaps, deferred items, rejected runs, common causes.
- [ ] **Release-quality gate.** Require a human-readable quality report (not just
      typecheck/tests) before publishing major changes; wire into the release
      docs/contract tests.
