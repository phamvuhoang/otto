# issue-19 — Otto Quality Verification Roadmap

GitHub issue #19 (OPEN). A three-feature roadmap about **output quality**: every
run should produce one concise, human-readable verification artifact that lets a
maintainer decide whether Otto solved the right problem with enough evidence to
trust it — not just "tests passed".

## Problem

The issue is a roadmap, not a single change. It spans three features:

1. **Standardize the quality report** — one readable verification artifact
   (verdict, task source, work summary, files, commits, checks, manual notes,
   gaps, deferred work, next action) reused across `otto-afk`, `otto-ghafk`,
   `otto-linear-afk`, and `--apply-review`, extending today's `--verify` report.
2. **Human acceptance playbooks** — per-mode acceptance-check prompts + a "human
   acceptance checklist" section in the report; a task-fulfillment quality lens.
3. **Close the feedback loop** — a lightweight human-verdict trail feeding the
   existing learning loop; cross-run quality summary; release-quality gate.

Per the AFK workflow this is decomposed into a spec + ordered plan; each run
implements exactly one plan task, test-first.

Reconciled against reality (git log + working tree, 2026-06-17): nothing in
`src`/`templates` references a "quality report" yet; the only report shape that
exists is `templates/verify.md`'s ad-hoc `## Done / ## Gaps / ## Deferred /
## Suites` structure, produced read-only by the `--verify` gate. This is
greenfield on `otto/19`.

## Approach

The whole roadmap rests on **one stable, reusable report contract**. So the
foundational task is to extract that contract into a single includable template
fragment (`templates/quality-report.md`) and adopt it first in the place a
report already exists (`verify.md`). Every later parity task (`ghafk`/`linear`
completion summaries, `--apply-review`) then `@include`s the *same* fragment
rather than re-describing the shape — the established repo convention for
provider-agnostic prose (see LEARNINGS: `ghprompt-workflow.md` is included, not
forked; `linear-completion.md` fragment is `@include`d by both Linear modes).

Because these are agent-driven behaviors with no otto code behind them (no `src`
function writes the report — the template instructs the agent), they are tested
at the **template / render-contract** level: render the template into a temp
workspace and assert the contract sections + invariants are present, mirroring
`apply-review.test.ts` / `superpowers-include.test.ts`.

The report stays **readable first** (the issue's #1 key risk is verbosity) and
**evidence-cited** (#2 risk: confident report hiding weak evidence). Critically,
the contract must respect the issue's "Deliberately Not Prioritized" item —
*model self-evaluation is not a replacement for human review* — so the verdict
defaults to **Needs human review** when evidence is thin or scope is uncertain,
mirroring the review-verify "bias to reject when unsure" convention.

## Assumptions (autonomous brainstorm — no human in the loop)

- **Q: One mega-change or incremental?** → Incremental: one plan task per AFK
  run, foundation first. Rationale: AFK workflow mandates single-task commits;
  the roadmap explicitly stages Feature 1 → 2 → 3.
- **Q: Where does the contract live?** → A new includable fragment
  `templates/quality-report.md`, not inlined per template. Rationale: the
  roadmap's #3 key risk is provider drift from different quality language; a
  single included fragment is exactly how the repo already prevents that
  (`ghprompt-workflow.md`, `linear-completion.md`).
- **Q: Which verdict vocabulary?** → The issue's four values: **Accepted ·
  Accepted with follow-ups · Needs human review · Rejected**, defaulting to
  *Needs human review* when uncertain. Rationale: the issue proposes exactly
  these; the default protects the "self-eval ≠ human review" boundary.
- **Q: Adopt the contract where first?** → `verify.md` (the existing report).
  Rationale: the roadmap says "extend the current `--verify` report shape into a
  reusable model"; it is the lowest-risk first adopter (read-only, one writer).
- **Q: Tests are verdict or evidence?** → Evidence. Rationale: explicit issue
  goal ("Make tests part of the evidence section, not the whole verdict").
- **Q: Keep `verify-report.md` scratch path?** → Yes, unchanged
  (`.otto-tmp/verify-report.md`, gitignored). Rationale: surgical; only the
  report's internal structure changes, not where it is written.

## Testing notes

- Fragment render-contract: render `quality-report.md` standalone and assert all
  six contract sections (`## Verdict`, `## Task Source`, `## What Changed`,
  `## Evidence`, `## Human Acceptance Checklist`, `## Gaps And Follow-Ups`), the
  four-value verdict vocabulary, the "Needs human review when unsure" default,
  and the tests-are-evidence-not-verdict instruction.
- `verify.md` include-contract: the template body contains
  `@include:quality-report.md`; rendered into a temp non-git workspace it
  surfaces the contract section headings (proving the include resolves) while the
  read-only / no-commit guardrails remain.
- All later tasks (parity, checklist, feedback trail) get their own
  render-contract assertions when implemented.
