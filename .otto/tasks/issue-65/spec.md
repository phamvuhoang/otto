# Spec — issue #65: P10 Live execution visualization

## Problem

A running Otto loop prints a firehose: `renderEvent` (`stream-render.ts`, called
per NDJSON line in `runner.ts:711`) streams **every** assistant text block to
stdout and **every** tool call/result to stderr, and the loop adds a per-stage
cost line. Progress (which iteration/stage, how far through the plan), spend, and
the *meaningful* actions (edits, commits, test results) are buried in raw model
tokens. So a watcher cannot tell at a glance what Otto is doing, can't catch a
stuck/looping run early, and ends up reading `.otto-tmp/logs`. A detached run is
worse — there is no attach-and-watch surface at all; you tail a raw log. And the
end of a run is a single dense line, not a verifiable "here is what happened".

P10's outcome: a **glanceable** real-time view (current stage, plan progress,
running cost, meaningful actions) that is quiet by default, an attach surface for
a detached run, and a crisp **done** card — degrading cleanly to plain lines for
non-TTY/CI.

## Approach

One **pure `RunView` model** derived from the evidence bundle (P0: `manifest` +
per-stage records, already written incrementally during a run), with pure
formatters, is the spine — so the in-run console, `otto-tail`, and the done card
share one source of truth instead of drifting into three renderers. Five units:

1. **`plan-progress.ts` (pure)** — `parsePlanProgress(md): PlanProgress` counts
   `- [x]` / `- [ ]` checkboxes in a task plan so the checklist "ticks as tasks
   complete" (the implementer flips boxes in its commits). Pure deterministic
   detector, mirroring `plan-rubric.ts`'s style. Reused by the console and tail.

2. **`run-view.ts` (pure)** — `RunView` (a normalized display snapshot: runId,
   bin/mode, status running/done/failed, iterations done/total, cost, tokens,
   elapsed, exit reason, next action, per-stage list, optional plan progress) +
   `buildRunView(manifest, stages, opts?)`; `formatDoneCard(view)` (the "done"
   card — outcome · cost · iterations · what landed · deferred · next action;
   **its first line keeps the existing greppable `Otto <reason> · N iteration(s)
   · $cost` string** so current loop assertions and log-scrapers survive) and
   `formatLiveTree(view)` (a progress tree iteration→stage + running totals +
   status, for the tail). All TTY styling via the existing `stream-render.ts`
   primitives (`USE_COLOR`, `SYM`), so `NO_COLOR`/non-TTY degrade automatically.

3. **`console-ui.ts` (the redesigned in-run console, append-mode)** — a small
   stateful renderer that consumes the **same parsed stream events** `renderEvent`
   sees, plus per-stage context (iteration, stage name), and emits **quiet,
   meaningful lines only**: classify a `tool_use`/`tool_result` into **edit**
   (`Edit`/`Write` → the path), **commit** (Bash `git commit …` → the subject),
   **test/typecheck** (Bash matching `pnpm test`/`vitest`/`tsc`/`pnpm … test`/
   `node --test`/`dotnet test` → pass/fail summarized from the result), or
   **error** (`is_error`); suppress raw assistant text and low-signal
   `Read`/`Glob`/`Grep`. Print a compact per-stage header (`iter N · <stage>`) and
   running cost/tokens after each stage. `--verbose` (new Otto flag) routes to
   today's `renderEvent` firehose unchanged. Honors `NO_COLOR`/non-TTY.

4. **`tail.ts` + `otto-tail` bin** — `runTail(argv, deps)`: resolve
   `<run-id>|latest`, poll `.otto/runs/<id>/` on an interval, re-render
   `formatLiveTree` while the run is in progress and `formatDoneCard` once the
   manifest is finalized, then exit 0. Pure poll-and-render over the bundle
   (reuses `listRunIds`/`readManifest`/`readStageRecords`). No server, no new data
   format. (`otto-watch` remains the ghafk issue-watching daemon — the attach
   surface is named `otto-tail` to avoid the collision.)

5. **Loop + runner wiring** — `runner.ts` currently hardcodes
   `renderEvent(parsed, toolMap)`; introduce an injectable **event sink** the loop
   selects (quiet `console-ui` vs verbose firehose) and sets the iteration/stage
   context on before each stage. `loop.ts` `summarize()` renders `formatDoneCard`
   at completion (in place of the bare line, keeping its greppable header line).

## Assumptions

Recorded decisions (taken with the maintainer in brainstorm):

- **Q: Scope of this PR?** → All three sub-features (console redesign + `otto-tail`
  + done card), using the lighter mechanisms (append-mode console, bundle-polling
  tail). *Rationale:* maintainer chose the complete P10 over a thinner vertical;
  append-mode + polling keep each piece tractable and testable.
- **Q: Console rendering model?** → Append-mode structured lines, NOT a
  full-screen TUI redraw. *Rationale:* line-oriented output degrades cleanly to
  logs/CI/`NO_COLOR`, reuses the existing write model, and is unit-testable; a
  redraw is fragile across terminals and hard to test.
- **Q: Live-view mechanism?** → `otto-tail` polls the bundle and re-renders via
  the shared formatters. *Rationale:* no server/port/browser; reuses P0 + the
  pure formatters; most Otto-idiomatic.
- **Q: What does quiet mode show?** → edits, commits, test/typecheck results, and
  errors only; assistant narration and `Read`/`Glob`/`Grep` are hidden unless
  `--verbose`. *Rationale:* these are the "meaningful actions" the hypothesis
  names; everything else is the noise P10 removes.
- **Q: Replace or keep the one-line summary?** → The done card replaces the dense
  tail but **keeps `Otto <reason> · N · $cost` as its first line** so existing
  greppable assertions/log-scrapers do not break.
- **Q: Where does the plan checklist come from?** → The task plan markdown
  (`.otto/tasks/<key>/plan.md` or the input plan file) parsed for checkboxes;
  absent → the checklist is simply omitted (no error).

## Scope guard

**In scope (this PR):** the five units above + their tests; the `--verbose`
Otto flag (`cli-help.ts` + `run-bin.ts`); the `otto-tail` bin + `package.json`
entry; README/docs for `otto-tail` and the quiet/verbose console; index exports.

**Out of scope / non-goals:** a full-screen TUI redraw; an HTTP server or HTML
page or live-markdown view (the bundle-polling `otto-tail` is the live view);
recording a new per-action event log in the bundle (the in-run console derives
actions from the live stream; `otto-tail` shows bundle-level progress — stages,
totals, plan checklist — not fine-grained actions); changing what the bundle
persists; the adaptive-router decision line beyond a modest reuse of existing
data.

## File map

- `packages/core/src/plan-progress.ts` — NEW pure parser + types.
- `packages/core/src/run-view.ts` — NEW `RunView`, `buildRunView`,
  `formatDoneCard`, `formatLiveTree` + types.
- `packages/core/src/console-ui.ts` — NEW append-mode in-run renderer + the event
  sink interface.
- `packages/core/src/tail.ts` — NEW `runTail(argv, deps)` + `TailDeps`.
- `packages/core/src/runner.ts` — replace the hardcoded `renderEvent` call with
  the injectable sink; thread per-stage context.
- `packages/core/src/loop.ts` — select quiet/verbose sink; render the done card
  in `summarize()`.
- `packages/core/src/cli-help.ts`, `run-bin.ts` — parse + thread `--verbose`.
- `packages/core/src/index.ts` — export the new functions/types.
- `apps/cli/bin/otto-tail.js` — NEW thin bin wrapper.
- `apps/cli/package.json` — add the `otto-tail` bin entry.
- `packages/core/src/__tests__/{plan-progress,run-view,console-ui,tail}.test.ts`
  — NEW; `runner.test.ts` / `loop.test.ts` / `cli-help.test.ts` /
  `run-bin.test.ts` — update for the sink + done card + flag.
- `README.md` — document `otto-tail` and quiet/`--verbose`.
- `.otto/tasks/issue-65/{spec.md,plan.md}` — this spec + the burn-down plan.
- `.otto/LEARNINGS.md` + `.otto/memory/<id>.json` — durable record.

## Testing notes

- **`plan-progress.test.ts`**: checked/total counts over mixed `- [x]`/`- [ ]`;
  nested/indented boxes; no-checkbox doc → `{checked:0,total:0}`; empty/garbage →
  no throw.
- **`run-view.test.ts`**: `buildRunView` maps a manifest+stages snapshot
  (running vs finalized) into the right status/counts/elapsed; `formatDoneCard`
  contains the greppable `Otto <reason> · N · $cost` first line + the
  card sections; `formatLiveTree` renders iteration→stage + totals; `NO_COLOR`
  path has no ANSI.
- **`console-ui.test.ts`**: feeding synthetic stream events, quiet mode emits a
  line for an edit/commit/test-result/error and **omits** assistant text and a
  `Read`; `--verbose`/firehose path delegates to `renderEvent`; classification of
  a `git commit` Bash command surfaces the subject; a test-command result is
  summarized pass/fail.
- **`tail.test.ts`** (mirror `inspect.test.ts`): resolves `latest`, renders the
  live tree for an in-progress manifest and the done card for a finalized one,
  errors + exits 1 on unknown id, polls until finalized (injectable
  clock/poll so the test is deterministic — no real sleeping).
- **Ripple**: `runner.test.ts` (sink injection), `loop.test.ts` (done-card output
  retains the greppable line), `cli-help.test.ts` + `run-bin.test.ts`
  (`--verbose`). Full `pnpm -r typecheck && pnpm -r test && pnpm test` green.
