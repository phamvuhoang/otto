# Plan (follow-ups) — issue #64: P9 Human-legible run reports

Executed via subagent-driven development on branch `feat/p9-human-legible-reports`,
after the thin vertical (contract rebuild + persistence + `otto-explain`, PR #73).
Three independent, well-bounded slices. Each is TDD: write/adjust the failing
test first, then make it pass. The fourth deferred item (embedded before/after
evidence: persist the diff patch / screenshots) stays deferred — more speculative
and heavier; not in this batch.

## Global constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js` (NodeNext).
- **Pure modules stay pure** — scorers/formatters return copies, never mutate;
  readers never throw (absent/malformed → safe `null`/`[]`).
- **Reuse, don't duplicate** — the plain-render path already exists
  (`report-explain.ts` `formatPlainReport` + `run-report.ts` `readRunReport`);
  new surfaces must call it, not re-implement it.
- **Verify gate** for every task: `pnpm -r typecheck && pnpm -r test && pnpm test`
  all green. Keep `.otto/LEARNINGS.md` terse (it is injected into every template;
  `scripts/smoke-templates.mjs` fails any rendered template > 20k tokens).
- **The `# Otto quality report` H1 is the persistence marker** — do not rename it.

## Task 1 — afk/plan-mode report coverage

**Problem.** The afk (plan/PRD) implementer playbook `templates/prompt.md` does
not `@include:quality-report.md`, so afk runs emit no Otto quality report and the
P9 loop capture (keyed on the `# Otto quality report` H1) persists nothing — afk
runs are invisible to `otto-explain`. ghafk/verify/apply-review/linear all emit
the contract; afk is the gap (the contract's own header comment even claims afk
is covered).

**Do.** Wire the shared contract into the afk completion path so an afk run emits
the layperson quality report when it finishes, exactly like the other modes —
through the single `@include:quality-report.md` (no re-described shape). The
report is the completion handoff: emit it when the work is done (the same point
the playbook emits `<promise>NO MORE TASKS</promise>`), not per-iteration. Place
the include in `templates/prompt.md`'s "FINISHING THE RUN" section. afk has no PR
/ issue surface, so the report lands as the implementer's final output (which the
loop persists to `.otto/runs/<id>/report.md`).

**Verify.**
- A new/extended template test renders the afk chain (`afk.md` → `prompt.md` →
  `quality-report.md`) in a throwaway non-git workspace and asserts the contract
  sections resolve end-to-end (mirror the ghafk case in `quality-report.test.ts`).
- Assert the report is tied to completion (emitted with / at the same finishing
  point as the sentinel), not per-iteration.
- Existing `prompt.md` / afk / quality-report tests stay green;
  `scripts/smoke-templates.mjs` stays under budget.

**Files.** `packages/core/templates/prompt.md`;
`packages/core/src/__tests__/quality-report.test.ts` (add an afk-coverage case).

## Task 2 — `otto-inspect --plain` alias

**Problem.** P9 added `otto-explain` as the non-engineer surface, but the roadmap
also named `otto-inspect --plain` for discoverability. There is no `--plain` flag
today.

**Do.** Add a `--plain` flag to `otto-inspect` that renders the same plain
report `otto-explain` produces, instead of the engineer report. **Reuse**
`report-explain.ts` `formatPlainReport` + `run-report.ts` `readRunReport` — do not
duplicate the rendering. Parse `--plain` from argv in `inspect.ts` (it may appear
before or after the run-id); when present, resolve the run id exactly as today,
read the manifest + persisted report, and print `formatPlainReport(manifest,
readRunReport(...))`. Without `--plain`, behavior is byte-for-byte unchanged.
`-h/--help` usage text mentions `--plain`.

**Verify.**
- `inspect.test.ts`: `runInspect(["--plain", id])` and `runInspect(["--plain"])`
  (latest) print the plain report (contains the run-facts footer / the persisted
  prose) and exit 0; `runInspect([id])` unchanged (engineer report); `--plain`
  with an unknown id still errors + exits 1.
- Full verify gate green.

**Files.** `packages/core/src/inspect.ts`;
`packages/core/src/__tests__/inspect.test.ts`. (No new bin.)

## Task 3 — report-legibility rubric + eval signal

**Problem.** P9's success metric is "% of reports a non-engineer understood
without reading code". There is no way to score a report's legibility — the
metric has no proxy. Mirror P8's plan-rubric: ship the pure scorer first.

**Do.** New pure `packages/core/src/report-rubric.ts`, a sibling to
`plan-rubric.ts` but scoring a **quality-report markdown document** for layperson
legibility. `scoreReportLegibility(doc): ReportRubricScore` checks deterministic
structural criteria for the P9 contract shape — e.g. `verdict` (`## Verdict`),
`whatChanged`, `why`, `howToVerify` (the section **plus** at least one numbered
step), `whatToWatch`, `uncertainty` (`## What I Was Unsure About`),
`engineerDivider` (the "Engineer detail below" divider, i.e. prose is actually
separated from engineer detail). Each criterion is a **pure deterministic
predicate** (header/keyword/regex heuristics, no tokenizer, no model). Return
per-criterion results, `metCount`/`maxScore`, a `0..1` `ratio` (0 when no
criteria — no divide-by-zero), and the `missing` list. `formatReportRubric`
renders an `N/M (P%)` scorecard + a `[x]`/`[ ]` line per criterion. Export a
fixed-order `REPORT_CRITERIA` array + the functions + types from `index.ts`.
Then surface it as an eval signal **exactly mirroring `planQualityRatio`**:
`EvalSignals.reportLegibilityRatio: number | null`, set in `scoreTrajectory` via
a new `opts.reportScore?: ReportRubricScore` (the caller passes a precomputed
score, keeping the scorer pure — `scoreTrajectory` does not read report text),
plus a higher-is-better "Report legibility" column in `compareTrajectories`.
INERT until a caller passes `reportScore` (like P8 slice 2).

**Verify.**
- `report-rubric.test.ts`: a complete P9 report → all criteria met, `ratio` 1,
  `missing` empty; a thin/engineer-first report → most unmet, low `ratio`,
  `missing` lists them; each criterion individually met vs unmet (detector is
  neither always-true nor always-false); empty/whitespace doc → 0 met, `ratio` 0,
  no throw; `formatReportRubric` renders each criterion + the score + missing
  note.
- `eval.test.ts`: `reportLegibilityRatio` is `null` without `reportScore` and the
  score's `ratio` when passed; the new compare column renders.
- Full verify gate green.

**Files.** `packages/core/src/report-rubric.ts` (NEW);
`packages/core/src/__tests__/report-rubric.test.ts` (NEW);
`packages/core/src/eval.ts`; `packages/core/src/__tests__/eval.test.ts`;
`packages/core/src/index.ts`.
