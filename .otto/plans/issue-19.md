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
- [x] **Parity: apply-review report.** `apply-review.md` emits the contract
      summarizing the review-fix round (CONFIRMED fixed, REJECTED, deferred).
      apply-review is a standalone gate template (no `ghprompt-workflow.md`
      include), so it `@include:quality-report.md` *directly* like `verify.md` —
      not via the shared FINISHING include. New COMPLETION REPORT section emits
      it once, only on the final iteration alongside the NO MORE TASKS sentinel
      (not per-iteration), mapping fixed→evidence and deferred/won't-fix→gaps.
      Render-contract test pins the include + sections + the round-summary prose.

## Feature 2 — Human acceptance playbooks

- [x] **Per-mode acceptance prompts.** Mode-specific acceptance-check question
      sets (plan/PRD, GitHub burn-down, Linear burn-down, external review repair,
      read-only verify) live in a sibling fragment
      `templates/acceptance-prompts.md`, `@include`d ONCE by `quality-report.md`
      so every adopting mode inherits the set through the existing contract
      include (drift-proof — no per-template re-description). Each mode set adds
      task-fulfillment questions a human can challenge, beyond the generic
      checklist. Render-contract test pins the include + every mode's prompts
      (`quality-report.test.ts`).
- [x] **Task-fulfillment review lens.** Add a `task-fit` lens to the review panel
      (`review-lens.md` is lens-parametric) focused on "did Otto solve the right
      problem / is it reviewer-useful", separate from correctness/security/tests.
      Test the lens wiring + default lens set unchanged. Done: `task-fit` is an
      opt-in lens *definition* added to `review-lens.md`'s lens-description list
      (augments, not replaces the three); `DEFAULT_LENSES` in `run-bin.ts` stays
      `correctness,security,tests` so it's opt-in via `OTTO_REVIEW_LENSES`.
      Render-contract test (`review-lens.test.ts`) pins the definition, the
      augment-not-replace invariant, and the generic `{{ LENS }}` header wiring.
- [x] **Sample verification transcripts.** Add `docs/` sample quality reports for
      a few realistic runs so users know what good output looks like. Doc-contract
      test pins their presence + required sections. Done: four filled-in samples in
      `docs/quality-report-samples.md` (ghafk / linear-afk / apply-review / verify,
      spanning the verdicts incl. the *Needs human review* default + GitHub↔Linear
      parity); `scripts/quality-report-samples.test.mjs` pins them against the REAL
      contract (`quality-report.md` sections + verdict vocab + modes, all parsed),
      and the README docs-table link.

## Feature 3 — Close the feedback loop

- [x] **Human-verdict trail.** A lightweight `.otto/verdicts.md` trail the
      quality-report contract surfaces + instructs the maintainer to append
      (Accepted / Accepted with follow-ups / Rejected / Needs investigation +
      why), feeding the existing learnings loop. Done: both halves live in the
      ONE shared `quality-report.md` fragment (a `<verdict-trail>` `!?`cat`
      surface + a maintainer-append instruction), so every mode inherits the
      trail through the existing contract include — drift-proof, no per-template
      edit. The trail section is a `###` (not `##`) so it doesn't pollute the
      samples doc-contract's six-`##`-section parse. Render-contract tested in
      `quality-report.test.ts` (surface-when-present, fallback, append
      instruction), mirroring the apply-review follow-up trail.
- [x] **Cross-run quality summary.** A read-only command/section summarizing
      completion count, gaps, deferred items, rejected runs, common causes.
      Done: a `# CROSS-RUN QUALITY SUMMARY (READ-ONLY)` section in `verify.md`
      (the only read-only inspection gate) that reads the git-tracked
      `.otto/verdicts.md` trail and appends a `## Cross-Run Quality Summary`
      block to the verify report (per-verdict tally, common causes, outstanding
      gaps/deferred). It is NOT a `##` in the shared `quality-report.md` — a
      cross-run rollup is not a per-run artifact and would pollute the
      six-section samples parse. Render-contract test in `quality-report.test.ts`.
- [x] **Release-quality gate.** Require a human-readable quality report (not just
      typecheck/tests) before publishing major changes; wire into the release
      docs/contract tests. Done: a `### Release-quality gate` subsection in
      RELEASING.md §2 requires BOTH machine verification (typecheck/tests/smoke)
      AND a human-accepted Otto quality report (links the real
      `quality-report.md` contract; clears only on Accepted / Accepted with
      follow-ups, never Needs human review / Rejected). Pinned by a new block in
      `scripts/releasing-contract.test.mjs` (heading present, both halves named,
      contract link exists on disk, gate-clearing verdicts stated).
