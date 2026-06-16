# issue-12 — Prepare For Broader Adoption

GitHub issue #12 (OPEN). Theme: launch readiness + extensibility — Otto is
credible as a public CLI/library with a clear support boundary, release process,
and extension path.

## Problem

Issue #12 is a broad theme with four initiatives and three success signals. It is
NOT a single change. Per the AFK workflow it is decomposed into this spec + an
ordered plan; each run implements exactly one plan task.

The four initiatives:

1. **Stable extension points** — document how to add stages, templates, and **run
   modes** without breaking the gate/reviewer contract.
2. **Release readiness** — keep release-please, changelog, package contents,
   provenance, and rollback steps current.
3. **Security documentation** — sandbox limits, `bypassPermissions`, trusted-input
   assumptions, `OTTO_RUNNER=host` tradeoffs explicit.
4. **Beta feedback cycle** — recruit maintainers, capture friction, rank a backlog.

Reconciled against reality (docs + git log + working tree, 2026-06-16):

- **Security docs (3) are already strong.** `SECURITY.md` has a "Threat model"
  section covering `bypassPermissions`, the trust boundary, the sandbox-vs-host
  blast radius, host-credential exposure, and a template-authoring invariant.
- **Release readiness (2) is already strong.** `RELEASING.md` has 8 sections incl.
  a rollback runbook, provenance (SBOM + cosign), and a compatibility matrix;
  `release-please-config.test.mjs` + `registries-not-behind-git.test.mjs` guard it.
- **Extension points (1) have a gap.** `CONTRIBUTING.md` documents "Adding a
  pipeline stage" and "Customizing prompts", but **run modes are undocumented** —
  yet the issue names run modes explicitly, and run modes are the extension most
  likely to break the gate/reviewer contract. A new contributor reading the docs
  cannot learn that a mode (e.g. `--verify`, `--apply-review`) is a flag that
  swaps the **gate** (index-0) stage in `run-bin.ts` while keeping the reviewer as
  the trailing non-gate stage. Nor is any of the extension-point documentation
  pinned by a contract test, so it can silently rot when `STAGES` changes.
- **Beta feedback (4) is a human/process activity** — not implementable as code in
  an AFK run. It is recorded in the plan as a non-code task (a checklist/template
  the maintainer drives), not attempted here.

So the highest-leverage, most-testable, lowest-risk first task is to close the
extension-points gap: document the **run-mode** extension point and pin all three
extension points (stage / template / run mode) with a doc-contract test, mirroring
the issue-8 `cli-docs-recipes.test.mjs` pattern (pin docs against source so a
rename in `stages.ts`/`run-bin.ts` fails the test instead of rotting the docs).

## Approach (plan task 1)

1. Add a concise **"## Adding a run mode"** section to `CONTRIBUTING.md`, after the
   existing "Customizing prompts" section. It explains that a run mode is a flag
   (handled in `run-bin.ts`) that **swaps the gate stage** at index 0 while
   preserving the chain's trailing reviewer — e.g. `--verify` → `[verifier]`,
   `--apply-review` → `[applyReviewImplementer, ...rest]`, `--issue` →
   `[issueStage, ...rest]`. It restates the two hard invariants: the first stage
   is the gate (sentinel `<promise>NO MORE TASKS</promise>` checked only at index
   0) and the reviewer never gates.
2. Add `scripts/contributing-extension-points.test.mjs` (root `node --test`,
   doc-contract, no build/network). It parses the real `STAGES` `name:` values out
   of `packages/core/src/stages.ts` and asserts:
   - `CONTRIBUTING.md` documents all three extension points (the three section
     headings: stage / prompt / run mode).
   - The run-mode section states the gate/reviewer contract (the exact sentinel +
     "first stage is the gate" wording).
   - Every stage name the run-mode section references is a real `STAGES` name, so a
     stage rename breaks the test rather than rotting the doc.

Pure docs + a markdown/source-parsing test — zero runtime-behavior change, so no
existing test churns; the new test is additive.

## Assumptions (question → chosen answer → rationale)

- **Which initiative first?** → Extension points (run-mode docs + contract test) →
  it is the issue's named gap (security + release docs already exist), it maps to
  the headline success signal ("a contributor can add a stage/template/mode using
  docs alone"), and it is the extension most able to break the gate/reviewer
  contract the issue says must be preserved. Highest value / lowest risk / testable.
- **New section vs rewrite existing?** → New "Adding a run mode" section, leave the
  existing stage/prompt sections intact → surgical; matches the repo's additive
  doc style and avoids churning passing prose.
- **How to test docs?** → Doc-contract test parsing `stages.ts` → the repo's
  established pattern (`cli-docs-recipes.test.mjs`, `release-please-config.test.mjs`):
  pin docs against source so drift fails CI, not a reader.
- **Cover release/security docs with new tests too?** → Deferred to later plan
  tasks → they are already strong and partly guarded; YAGNI for this run.
- **Implement the beta-feedback cycle?** → No → it is a human/process activity
  (recruit maintainers, collect feedback). Recorded as a non-code plan task with a
  feedback-capture template; not attempted in an AFK run.

## Testing notes

- `scripts/contributing-extension-points.test.mjs` via root `pnpm test`
  (`node --test`). No build or network — reads `CONTRIBUTING.md` and parses
  `stages.ts` directly.
- Feedback loops: `pnpm -r typecheck && pnpm -r test && pnpm test`.

## Out of scope (future plan tasks — not this run)

Release-readiness contract test (changelog/package-contents/provenance pinned to
`RELEASING.md`); a security-doc contract test pinning the threat-model invariants;
the beta-feedback capture template + ranked-backlog process. Tracked in
`.otto/plans/issue-12.md`.
