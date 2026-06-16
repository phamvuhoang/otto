# issue-8 — Improve Maintainer Workflows

GitHub issue #8 (OPEN). Theme: better control + legibility for the GitHub-issue
and review-driven loops, so a maintainer who leaves Otto running AFK can later
understand exactly what happened, what landed, and what remains.

## Problem

Issue #8 is a broad theme with four initiatives and three success signals. It is
NOT a single change. Per the AFK workflow it must be decomposed into a spec +
ordered plan; each run implements exactly one plan task.

Reconciled against reality (git log + working tree, 2026-06-16): issue #5
already landed the unified `summarize()` end-of-run line, preflight diagnostics,
and interrupt-path cleanup. So the summary line *exists* but only reports
`reason · iterations · cost`. The issue's headline success signal —

> A run produces an understandable end-state summary: completed work, deferred
> work, cost, and **next action**.

— is only partly met: the **next action** is missing. A maintainer reading the
final line still has to know, per exit reason, what to do next (raise the budget?
re-run to resume? open a PR?). That is the highest-leverage, most-testable,
lowest-risk gap, so it is plan task 1.

## Approach

Add a per-reason **next-action hint** to the end-of-run summary. The summary
already funnels every terminal path through one `summarize(reason, iterations)`
helper in `loop.ts` (see LEARNINGS — "Every terminal exit path … funnels through
one `summarize`"). Extend that single helper rather than touching call sites:

- A pure, exported `nextActionFor(reason: string): string` maps each exit reason
  to a terse imperative hint. Pure + exported so it is unit-testable directly
  (repo convention: host-touching/decision logic is pure and injectable).
- `summarize` prints the existing first line unchanged, then a second dim
  continuation line: `  → next: <hint>`. Written to **stdout** with the `*Out`
  color helpers (`dimOut`), per the LEARNINGS rule that summary/completion lines
  go to stdout and must not use the stderr-gated helpers (avoids ANSI leaking
  into redirected stdout).

Keeping the first line byte-identical means every existing `toContain(...)`
assertion in `loop.test.ts` still passes; the new line is additive.

Reason → next action map:

| reason                | next action                                                  |
| --------------------- | ------------------------------------------------------------ |
| `complete`            | review the diff, then open a PR                              |
| `done`                | review the diff, then open a PR                              |
| `done with failures`  | inspect the failed stage logs under `.otto-tmp/logs`, then re-run |
| `stopped (budget)`    | raise `--budget` and re-run to resume                       |
| `halted (rate limit)` | re-run after the limit resets to resume                     |
| `aborted`             | re-run to resume from the saved iteration                   |
| `stopped (error)`     | inspect the error above, then re-run                        |
| _(unknown)_           | re-run to resume                                            |

## Assumptions (question → chosen answer → rationale)

- **Which initiative first?** → The end-state summary's missing "next action" →
  it is the issue's headline success signal, purely a function of an existing
  value (`reason`), needs no new I/O or coupling, and extends a well-tested
  helper. Highest value / lowest risk / most testable.
- **Same line or new line?** → New dim continuation line → keeps the first line
  byte-identical (no existing-test churn) and reads cleanly; mirrors the panel's
  continuation-line style.
- **stdout or stderr?** → stdout via `dimOut` → it is part of the summary;
  LEARNINGS mandates summary lines go to stdout with `*Out` helpers so they
  survive `> out.txt` redirection.
- **Surface deferred-work count too?** → Deferred to a later plan task → it
  requires reading/parsing `.otto/review-followups.md`, coupling `loop.ts` to a
  file format; out of scope for the minimal first task (YAGNI).
- **Key off reason string or a stable enum?** → Off the exact reason string via
  a lookup with a safe default → reasons are fixed literals already passed to
  `summarize`; a defaulted lookup avoids a parallel enum and is trivially
  testable. Unknown reasons fall back to a generic hint, never throw.

## Testing notes

- Unit: `nextActionFor` returns the expected hint for each known reason and the
  fallback for an unknown one (new focused test in `loop.test.ts`).
- Integration: extend existing end-of-run-summary tests to assert the `→ next:`
  line appears for at least the `complete`, `stopped (budget)`, and
  `done with failures` paths (reuse the `stdoutText()` harness).
- Feedback loops: `pnpm -r test` + `pnpm -r typecheck`.

## Out of scope (future plan tasks — not this run)

Deferred-work surfacing in the summary; mode comparison table (afk vs ghafk vs
verify vs apply-review) in docs; worked recipes (issue burn-down / review repair
/ overnight); clearer empty-queue & auth-failure messages in watch mode;
apply-review follow-up-trail tests. Tracked in `.otto/plans/issue-8.md`.
