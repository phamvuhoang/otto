# Spec — issue #64: P9 Human-legible run reports

## Problem

The artifact a run leaves behind is written for someone who reads diffs. The
`# Otto quality report` contract (`templates/quality-report.md`, `@include`d by
every run mode) leads with **Verdict → Task Source → What Changed → Evidence** —
the verdict is followed immediately by provenance and a code-cited evidence dump.
A non-engineer stakeholder (PM, founder, ops) cannot read it and decide *accept
or reject*: there is no plain-language "what this does for a user", the
verification steps are commands, and the uncertainty is implicit. P9's outcome:
every run produces an **outcome-framed, plain-language report a non-engineer can
verify** — *what changed · why · how to check it works (non-technical) · what to
watch* — with the engineer detail kept one click down, plus a way to re-render
any past run for that audience.

Two structural gaps make today's report layperson-hostile and un-revisitable:

1. **The contract is engineer-first.** Its section order puts code evidence
   above human meaning, and it has no section for plain-language verification or
   uncertainty.
2. **The emitted report is not persisted.** The run bundle
   (`.otto/runs/<id>/`) keeps the *structured* trajectory — `manifest.json`
   (cost, tokens, exit reason) and per-stage records — but the prose report the
   implementer writes lives only in the stage's transient output / the PR body.
   Nothing can re-show it later, so there is no past-run handoff artifact and no
   `otto-explain`.

## Approach

Ship one **end-to-end thin vertical** — the smallest change that lets a
non-engineer verify a run, today, end to end — rather than P7/P8's
pure-substrate-first slicing. The legibility *rubric/eval-signal* (the P8-shaped
pure scorer) is deferred to a follow-up slice; it measures a surface that must
exist first. Three coupled pieces:

1. **Rebuild the contract for a layperson** (`templates/quality-report.md`).
   Reorder the report body to lead with prose — **What changed · Why · How to
   verify · What to watch / risks · What I was unsure about** — and move the
   code-cited **Evidence**, **Task Source**, acceptance checklist and follow-ups
   below a visible "engineer detail" divider. The `# Otto quality report` H1 and
   the `## Verdict` block stay first and unchanged: the H1 is the persistence
   marker (below) and the honest-verdict discipline is load-bearing. Every run
   mode inherits the new shape through the single `@include` — no per-template
   drift.

2. **Persist the emitted report into the bundle** (`loop.ts` + `run-report.ts`).
   The report is emitted by whichever stage's template `@include`s the contract
   (the **implementer** in ghafk/verify/apply-review/linear; the reviewer never
   emits one). So capture by **content marker, not stage name**: the loop tracks
   the most recent stage `result` containing the `# Otto quality report` H1;
   `finalizeManifest` writes it to `.otto/runs/<id>/report.md` and links it as a
   `RunArtifact {kind: "report"}`. Best-effort — a bundle write must never break
   a run (mirrors the existing manifest/stage writes) — and gracefully absent
   when no stage emitted a report (plan/PRD `afk` mode, older runs).

3. **`otto-explain <run-id>` — re-render any past run plainly** (`report-explain.ts`
   + new bin). A pure `formatPlainReport(manifest, reportText | null)` prints the
   persisted plain report, then a compact "run facts" footer (iterations, cost,
   source) from the manifest. When no `report.md` is present it prints the
   manifest facts plus a one-line note ("this run didn't emit a plain report —
   older run or plan/PRD mode"). `runExplain(argv, deps)` mirrors `runInspect`'s
   shape (resolve `<run-id>|latest`, read the bundle, print). A thin
   `bin/otto-explain.js` wraps it; `otto-inspect` stays the engineer view.

## Assumptions

Recorded assumptions (decisions taken with the maintainer in brainstorm):

- **Q: How much ships this PR?** → The end-to-end thin vertical (contract +
  persistence + `otto-explain`), not foundation-first. *Rationale:* maintainer
  chose user-visible value now over the pure-scorer-first cadence; the vertical
  is still small and each piece is independently testable.
- **Q: Where does `otto-explain`'s prose come from?** → The agent-emitted report,
  persisted as a bundle artifact. *Rationale:* the prose is semantic (model
  authored); deterministic render from the manifest alone cannot produce a real
  "what changed / why / how to verify" narrative, and re-generating via a fresh
  model call per inspect costs tokens and is non-deterministic.
- **Q: New `otto-explain` bin or `otto-inspect --plain` flag?** → New bin.
  *Rationale:* the roadmap names it first; a distinct verb signals the
  non-engineer audience and keeps `otto-inspect` engineer-facing. An
  `otto-inspect --plain` alias is a deferred follow-up.
- **Q: Capture the report by stage name or by content?** → By content marker
  (`# Otto quality report`), taking the most recent matching stage result.
  *Rationale:* the emitting stage differs per mode and afk emits none; a content
  match is robust across modes and gracefully absent.
- **Q: Fix the afk/plan-mode report gap (its `prompt.md` doesn't `@include` the
  contract) in this PR?** → No, deferred. *Rationale:* surgical scope — P9's
  vertical is the contract+persistence+explain spine; widening report coverage to
  afk is a separate, named follow-up.

## Scope guard

**In scope (this PR):**

- Reorder `templates/quality-report.md` to layperson-first with the new prose
  sections + an engineer-detail divider; keep H1 + Verdict + verdict-trail.
- `run-report.ts`: `writeRunReport` / `readRunReport` helpers + the `report`
  artifact kind.
- `loop.ts`: track the latest report-bearing stage result; persist it in
  `finalizeManifest` (best-effort).
- `report-explain.ts`: pure `formatPlainReport` + `runExplain` driver, exported
  from `index.ts`.
- `apps/cli/bin/otto-explain.js` + the `package.json` bin entry.
- Tests for every piece + ripple fixes to `quality-report.test.ts` /
  `apply-review.test.ts` (they pin the section order).

**Out of scope (deferred follow-ups, listed in `plan.md`):** a report-legibility
rubric + eval signal (P8-shaped pure scorer; the "% understood without code"
metric proxy); afk/plan-mode report coverage (`prompt.md` `@include`);
embedded before/after evidence (persist the diff patch / screenshots as
artifacts); `otto-inspect --plain` alias; rendering verdict/source as parsed
fields rather than passthrough prose.

**Non-goals:** an LLM-scored legibility judge; translating/parsing the prose into
structured fields (the report is shown as authored); any change to the verdict
discipline or the acceptance/verdict-trail loop.

## File map

- `packages/core/templates/quality-report.md` — reorder body; add prose sections
  + engineer-detail divider. H1/Verdict/verdict-trail unchanged.
- `packages/core/src/run-report.ts` — NEW `writeRunReport` / `readRunReport`;
  `report` artifact kind. Helpers are pure-ish fs wrappers, best-effort on write.
- `packages/core/src/loop.ts` — track most-recent report-bearing stage `result`;
  write it in `finalizeManifest`; add the `report` artifact in `collectArtifacts`.
- `packages/core/src/report-explain.ts` — NEW pure `formatPlainReport` +
  `runExplain(argv, deps)` driver (mirrors `inspect.ts`).
- `packages/core/src/index.ts` — export `formatPlainReport`, `runExplain`,
  `writeRunReport`, `readRunReport` (+ any new types).
- `apps/cli/bin/otto-explain.js` — NEW thin bin wrapper (mirrors
  `otto-inspect.js`).
- `apps/cli/package.json` — add `"otto-explain"` to `bin`.
- `packages/core/src/__tests__/report-explain.test.ts` — NEW.
- `packages/core/src/__tests__/{quality-report,apply-review}.test.ts` — update
  the pinned section list/order.
- `packages/core/src/__tests__/run-report.test.ts` — cover the new helpers +
  persistence path.
- `.otto/tasks/issue-64/{spec.md,plan.md}` — this spec + the burn-down plan.
- `.otto/LEARNINGS.md` + `.otto/memory/<id>.json` — durable record of the slice.
- `README.md` — document `otto-explain` in the bins/commands reference.

## Testing notes

- **Contract order** (`quality-report.test.ts`, `apply-review.test.ts`): assert
  the new section headings appear in the new order, the prose sections precede
  the engineer-detail divider, and the H1/Verdict/verdict-trail are intact. These
  tests already encode the six-section order — update the expected list.
- **Persistence** (`run-report.test.ts`): `writeRunReport`/`readRunReport`
  round-trip; reading an absent report → `null` (no throw); a finalize path that
  is handed a report-bearing result writes `report.md` and links the `report`
  artifact, and one with no marker writes neither.
- **`report-explain`** (`report-explain.test.ts`): `formatPlainReport` with a
  report present → the prose leads, the facts footer shows iterations/cost/source;
  with `reportText = null` → the absent-report note + manifest facts; `runExplain`
  resolves `latest`, errors cleanly on an unknown run id, and exits 0/1
  appropriately (mirror `inspect.test.ts`).
- **Regression**: full `pnpm -r typecheck && pnpm -r test && pnpm test` green.
  Persistence is best-effort and gated on the content marker, so non-emitting
  modes (afk) and existing bundles are unaffected.
