# Sample quality reports

These are **illustrative, filled-in** [Otto quality reports](../packages/core/templates/quality-report.md) — what good verification output looks like for a few realistic runs. They are samples, not transcripts of a specific run; the SHAs, issue numbers, and `file:line` citations are representative.

Read them to calibrate: a report should be short enough to review in a couple of minutes, cite concrete evidence for every claim, fold in the [mode-specific acceptance prompts](../packages/core/templates/acceptance-prompts.md), and pick an honest verdict — **Needs human review** when evidence is thin or scope is uncertain, never a self-declared **Accepted**.

The contract shape these all follow is defined once in [`quality-report.md`](../packages/core/templates/quality-report.md); placement differs per mode (PR body / issue comment / `.otto-tmp/verify-report.md`) but the sections are identical.

---

## 1. GitHub issue burn-down (`otto-ghafk`)

A single-issue run that landed on a feature branch and opened a PR. The issue stays OPEN until the PR merges, so the verdict carries a follow-up.

````markdown
# Otto quality report

## Verdict

**Accepted with follow-ups** — feature is complete and tested, but one edge case is deferred (see Gaps).

## Task Source

- Mode: ghafk
- Source: GitHub issue #42 — "Add `--max-retries` flag to cap per-stage retries"
- Issue or plan: https://github.com/acme/otto/issues/42

## What Changed

- Summary: Added a `--max-retries <n>` CLI flag that overrides the default per-stage retry ceiling; threaded it through `parseFlags` → `withRetries`.
- Commits: `a1b9f0c` feat(cli): add --max-retries flag
- Files: `apps/cli/src/cli-help.ts`, `packages/core/src/retry.ts`, `packages/core/src/__tests__/retry.test.ts`

## Evidence

- Implementation evidence: clamp + default live at `retry.ts:31` (`Math.max(0, maxRetries ?? DEFAULT_RETRIES)`); flag parsed at `cli-help.ts:88`.
- Test/typecheck evidence: `pnpm -r test` → 214 passed, 0 failed (3 new cases in `retry.test.ts`); `pnpm -r typecheck` clean.
- Manual or acceptance evidence: ran `otto-ghafk --max-retries 1 --print-config` and confirmed the resolved config reports `maxRetries: 1`.

## Human Acceptance Checklist

- [x] Solves the stated problem. — flag caps retries as requested (`retry.test.ts:40`).
- [x] Behavior is observable or explained. — `--print-config` echoes the resolved value.
- [x] Scope is appropriate. — touched only the retry path; no stage/loop changes.
- [x] Docs/examples are updated when needed. — added to `docs/CLI.md` flag table.
- [x] Risks and assumptions are clear. — see Gaps.
- [x] The change resolves what the issue actually asked, not an adjacent reading.
- [x] Work is scoped to this issue; unrelated changes are called out. — none.
- [ ] The issue will close cleanly when the PR merges. — PR open, not yet merged (cited below).

## Gaps And Follow-Ups

- Gap: a `--max-retries 0` value disables retries entirely; this is intended but undocumented as a "no retry" mode.
- Deferred: negative values are clamped to 0 rather than rejected — acceptable, but a future run could warn instead.
- Recommended next action: review and merge PR https://github.com/acme/otto/pull/57 (branch `otto/42`); the issue auto-closes on merge.
````

---

## 2. Linear issue burn-down (`otto-linear-afk`)

A Linear run against a PR-based repo. Per convention the issue is **left OPEN** and the verdict is handed off in the Linear comment, citing the branch/PR and the explicit human next step.

````markdown
# Otto quality report

## Verdict

**Accepted** — the Linear issue's intent is fully implemented, tested, and pushed; ready for human merge.

## Task Source

- Mode: linear-afk
- Source: Linear OTTO-23 — "Cache `gh` issue bodies to cut redundant API calls"
- Issue or plan: https://linear.app/acme/issue/OTTO-23

## What Changed

- Summary: Memoized issue-body fetches within a single watch poll so the same issue is fetched at most once per cycle.
- Commits: `7c4d2e1` feat(watch): memoize issue-body fetch per poll
- Files: `packages/core/src/watch.ts`, `packages/core/src/__tests__/watch.test.ts`

## Evidence

- Implementation evidence: the per-poll cache `Map` is built at `watch.ts:64` and cleared each cycle at `watch.ts:91`.
- Test/typecheck evidence: `pnpm -r test` → 218 passed; new case "fetches each issue body once per poll" asserts a single call via a spy (`watch.test.ts:120`).
- Manual or acceptance evidence: none (daemon behavior covered by the spy-based test rather than a live poll).

## Human Acceptance Checklist

- [x] Solves the stated problem. — duplicate fetches eliminated within a poll.
- [x] Behavior is observable or explained. — call-count asserted in the test.
- [x] Scope is appropriate. — cache is poll-scoped; cross-poll behavior unchanged.
- [x] Docs/examples are updated when needed. — internal change; no user-facing docs.
- [x] Risks and assumptions are clear. — cache lifetime is one poll (see Gaps).
- [x] The change resolves the Linear issue's stated intent.
- [x] The comment cites the branch/PR and the explicit human next step.
- [x] The issue is left in the correct state (OPEN for PR-based repos).

## Gaps And Follow-Ups

- Gap: none.
- Deferred: cross-poll caching (issues rarely change body between polls) — out of scope for OTTO-23.
- Recommended next action: review and merge PR `acme/otto#58` (branch `otto/otto-23`); leave OTTO-23 OPEN — it is closed manually after merge per repo convention.
````

---

## 3. External review repair (`--apply-review`)

A run that triaged an external code-review document, fixing CONFIRMED findings one per iteration. The report summarizes the round: what was fixed, what was rejected, what was deferred.

````markdown
# Otto quality report

## Verdict

**Accepted with follow-ups** — all CONFIRMED findings fixed; two findings rejected with reasons, one deferred.

## Task Source

- Mode: apply-review
- Source: external review `./code-review.md` (5 findings)
- Issue or plan: ./code-review.md

## What Changed

- Summary: Fixed the two CONFIRMED defects — an unhandled rejection in the streaming reader and a missing newline in the NDJSON writer.
- Commits: `b2e0a44` fix(review): handle stream reader rejection; `c9f1d70` fix(review): terminate NDJSON lines
- Files: `packages/core/src/runner.ts`, `packages/core/src/stream-render.ts`

## Evidence

- Implementation evidence: the reader now `try/catch`es and surfaces the error at `runner.ts:142`; NDJSON writer appends `\n` at `stream-render.ts:58`.
- Test/typecheck evidence: `pnpm -r test` → 220 passed (2 regression cases added); `pnpm -r typecheck` clean.
- Manual or acceptance evidence: re-ran the review doc through `--apply-review` and confirmed the gate reports `<promise>NO MORE TASKS</promise>` (no actionable findings remain).

## Human Acceptance Checklist

- [x] Solves the stated problem. — both CONFIRMED findings closed.
- [x] Behavior is observable or explained. — regression tests reproduce each bug.
- [x] Scope is appropriate. — only the two cited files changed.
- [x] Docs/examples are updated when needed. — no docs affected.
- [x] Risks and assumptions are clear. — see deferred finding.
- [x] Every CONFIRMED finding was actually fixed, not just acknowledged.
- [x] The fixes introduced no regression (suites re-run green).
- [x] Deferred / rejected findings are recorded with a reason.

## Gaps And Follow-Ups

- Gap: none in the fixed paths.
- Deferred: finding #4 ("consider backpressure on the NDJSON stream") — appended to `.otto/review-followups.md`; needs a design decision, out of scope for a one-line fix.
- Recommended next action: two findings were REJECTED (cosmetic naming, false-positive race) with rationale in `verdicts.md`; a maintainer should confirm the rejections before closing the review.
````

---

## 4. Read-only verification (`--verify`)

A verify pass over a plan where the evidence did not fully back the plan's checkmarks. This is the honest-default case: the verdict is **Needs human review**, not Accepted.

````markdown
# Otto quality report

## Verdict

**Needs human review** — two plan tasks are checked off but lack committed evidence; do not accept on the report alone.

## Task Source

- Mode: verify
- Source: plan `./docs/plans/inventory.md`
- Issue or plan: ./docs/plans/inventory.md

## What Changed

- Summary: Nothing — `--verify` is read-only. This report classifies each plan task as DONE / GAP / DEFERRED against committed reality.
- Commits: none (no edits, no commits — verify never writes to sources).
- Files: none changed; report written to `.otto-tmp/verify-report.md` (gitignored scratch).

## Evidence

- Implementation evidence: 4 of 6 plan tasks trace to commits (e.g. "CSV export" → `inventory.ts:88`, commit `d11a0b2`).
- Test/typecheck evidence: `pnpm -r test` → 198 passed; `pnpm -r typecheck` clean — but the suites do not cover the two unverified tasks.
- Manual or acceptance evidence: none — the "low-stock alert" and "supplier sync" tasks have no test and no obvious `file:line`, so their checkmarks could not be confirmed.

## Human Acceptance Checklist

- [ ] Solves the stated problem. — partially; 2 tasks unverifiable from the tree.
- [x] Behavior is observable or explained. — for the 4 verified tasks.
- [x] Scope is appropriate. — read-only pass, no source touched.
- [ ] Docs/examples are updated when needed. — plan claims docs updated; not found.
- [x] Risks and assumptions are clear. — flagged below.
- [ ] Each task's claimed status matches committed reality (evidence cited). — 2 mismatches.
- [x] Suite results are current, not stale. — suites run this pass.
- [x] Gaps and deferrals are honest, not optimistic.

## Gaps And Follow-Ups

- Gap: "low-stock alert" and "supplier sync" are checked in the plan but have no commit/test evidence — likely premature checkmarks.
- Deferred: none claimed by the plan.
- Recommended next action: a maintainer should manually confirm or re-open the two unverified tasks before treating the plan as done; consider adding tests that pin them.
````
