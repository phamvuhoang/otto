# Plan — issue #64: P9 Human-legible run reports

Ordered, bite-sized, testable tasks. The issue is Medium; this ships an
**end-to-end thin vertical** (contract → persistence → `otto-explain`) so a
non-engineer can verify a run today, then names the legibility-rubric and
coverage work as deferred follow-ups. Each task is TDD: write/adjust the failing
test, then make it pass.

- [ ] **1. Rebuild the contract for a layperson.** Reorder
  `templates/quality-report.md` body to lead with prose — **What changed · Why ·
  How to verify · What to watch / risks · What I was unsure about** — and move
  **Evidence / Task Source / Human Acceptance Checklist / Gaps And Follow-Ups**
  below a visible engineer-detail divider. Keep `# Otto quality report` H1, the
  `## Verdict` block, and the verdict-trail first/intact (the H1 is the
  persistence marker; the verdict discipline is load-bearing). Update the pinned
  section order in `quality-report.test.ts` + `apply-review.test.ts`. → verify:
  those suites assert the new order; H1/Verdict unchanged; `pnpm -r test` green.

- [ ] **2. Persist the emitted report into the bundle.** `run-report.ts`: add
  `writeRunReport(workspaceDir, runId, text)` / `readRunReport(workspaceDir,
  runId): string | null` (best-effort write, never throws) and a `report`
  artifact kind. `loop.ts`: track the most recent stage `result` containing the
  `# Otto quality report` H1; in `finalizeManifest` write it to
  `.otto/runs/<id>/report.md` and link it via `collectArtifacts`. No marker →
  write nothing. → verify: `run-report.test.ts` round-trips the helper, absent →
  `null`; a report-bearing finalize writes `report.md` + the artifact, a
  marker-less one writes neither.

- [ ] **3. `otto-explain <run-id>` — plain re-render.** `report-explain.ts`: pure
  `formatPlainReport(manifest, reportText | null)` — prose report first, then a
  compact run-facts footer (iterations, cost, source); `null` → an absent-report
  note + manifest facts. `runExplain(argv, deps)` mirrors `runInspect` (resolve
  `<run-id>|latest`, read bundle, print; clean error + exit 1 on unknown id).
  Export both from `index.ts`. → verify: `report-explain.test.ts` covers
  present/absent prose, `latest` resolution, unknown-id error.

- [ ] **4. Wire the `otto-explain` bin + docs.** `apps/cli/bin/otto-explain.js`
  (thin wrapper, mirrors `otto-inspect.js`); add `"otto-explain"` to
  `apps/cli/package.json` `bin`. Document the command in `README.md`. → verify:
  `node apps/cli/bin/otto-explain.js latest` prints the plain report for an
  existing bundle; `pnpm test` (root) green.

- [ ] **5. Record the slice.** Append the P9 vertical's conventions/decisions to
  `.otto/LEARNINGS.md` and write a governed-memory record under `.otto/memory/`,
  within the work commit. → verify: files present; full
  `pnpm -r typecheck && pnpm -r test && pnpm test` green.

## Deferred follow-ups (not blocking — named for the next runs)

- **Report-legibility rubric + eval signal** — a pure `report-rubric.ts`
  (P8-shaped) scoring the layperson sections (plain What/Why, non-technical
  verify steps, stated uncertainty, before/after evidence); capture it as an
  `EvalSignals` field. This is the success-metric proxy ("% understood without
  reading code") and the gate a future "re-write for legibility" loop reads.
- **afk/plan-mode report coverage** — `prompt.md` doesn't `@include` the contract,
  so plan/PRD runs emit no report (and persist none). Wire it so afk runs are
  legible too.
- **Embedded before/after evidence** — persist the HEAD diff patch (and, where a
  changed surface has one, a screenshot) as bundle artifacts so `otto-explain`
  can show concrete before/after, not just prose.
- **`otto-inspect --plain` alias** — route the engineer bin's `--plain` flag to
  the same renderer for discoverability.
