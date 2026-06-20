# Plan — issue #65: P10 Live execution visualization

Executed via subagent-driven development on branch
`feat/p10-live-execution-visualization`. Ordered so the pure foundations land
first (a `RunView` everything renders from), then the loop/runner wiring, then the
new surfaces. Each task is TDD: write the failing test first, then implement.

## Global constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js` (NodeNext).
- **Pure modules stay pure** — parsers/formatters return copies, never mutate;
  readers never throw (absent/malformed → safe defaults). Bundle reads reuse the
  P0 helpers in `run-report.ts`; do NOT add a new persisted format.
- **All TTY styling goes through `stream-render.ts`** (`USE_COLOR`,
  `USE_COLOR_STDOUT`, `SYM`, `dim`/`bold`/`green`/…). Honor `NO_COLOR`/non-TTY:
  every new renderer must emit clean ANSI-free lines when color is off. No
  full-screen redraw / alternate screen buffer — append-mode lines only.
- **Keep the greppable completion line.** The done card's FIRST line must contain
  `Otto <reason> · N iteration(s) · $<cost>` so existing `loop.test.ts`
  assertions and any log-scraper keep working.
- **`otto-watch` is the ghafk daemon — do NOT reuse the name.** The attach
  surface is `otto-tail`.
- **Verify gate** for every task: `pnpm -r typecheck && pnpm -r test && pnpm test`
  green. Keep `.otto/LEARNINGS.md` terse (injected into every template;
  `scripts/smoke-templates.mjs` fails any rendered template > 20k tokens — ghafk
  is already ~18k, so add at most a one-line bullet).

## Task 1 — `plan-progress.ts` (pure plan-checklist parser)

Foundation. NEW `packages/core/src/plan-progress.ts`:
`parsePlanProgress(md: string): PlanProgress` where `PlanProgress = { checked:
number; total: number; items: { text: string; done: boolean }[] }`. Count GitHub
task-list checkboxes — lines matching `^\s*[-*]\s+\[( |x|X)\]\s+(.*)$` — `done`
when the box is `x`/`X`. No checkboxes → `{ checked: 0, total: 0, items: [] }`.
Pure, deterministic, never throws (empty/garbage → empty result). Export from
`index.ts`. → verify: `plan-progress.test.ts` — mixed checked/unchecked counts,
indented boxes, `[X]` uppercase, lines that look like boxes but aren't (e.g.
`[ ]` mid-sentence) excluded, empty/garbage → empty, no throw.

## Task 2 — `run-view.ts` (shared model + formatters)

NEW `packages/core/src/run-view.ts`. Depends on Task 1 + the P0 bundle types
(`RunManifest`/`StageRecord` from `run-report.ts`).
- `RunView` type: `{ runId, bin, mode, status: "running"|"done"|"failed",
  iterationsDone, iterationsTotal, costUsd, tokenUsage, elapsedMs: number|null,
  exitReason: string|null, nextAction: string|null, stages: { iteration, stage,
  isError }[], planProgress?: PlanProgress }`.
- `buildRunView(manifest, stages, opts?: { planProgress?: PlanProgress }):
  RunView` — `status` is `running` when `manifest.finishedAt` is absent, else
  `failed` when the exit reason indicates failure (reuse the same notion
  `loop.ts` uses for a failed exit) else `done`; `elapsedMs` from
  started/finished (null when un-finalized/unparseable, never NaN — mirror
  `eval.ts` elapsed handling).
- `formatDoneCard(view): string` — FIRST line `Otto <reason> · N iteration(s) ·
  $<cost>` (greppable), then card sections: what landed (stage summary / commits
  count if available), plan progress (`checked/total`) when present, deferred
  follow-ups note when the bundle has the review-followups artifact, and the
  next-action line. Reuse `stream-render.ts` styling.
- `formatLiveTree(view): string` — a status header + a progress tree (iteration →
  stage, current stage marked) + running cost/tokens/elapsed + plan progress.
- Export all from `index.ts`. → verify: `run-view.test.ts` — running vs finalized
  vs failed mapping; `elapsedMs` null-not-NaN; done-card greppable first line +
  sections; live-tree tree + totals; `NO_COLOR` → no ANSI escapes.

## Task 3 — Loop renders the done card at completion

Wire `formatDoneCard` into `loop.ts` `summarize()` (replacing the bare summary
line, keeping its greppable header line). Build the `RunView` from the in-memory
run totals + recorded stages at the terminal path; read the task plan for
`planProgress` when a plan path is known (best-effort — absent → omit). Do NOT
change exit codes or the manifest. → verify: update `loop.test.ts` — the
completion output still contains `Otto done · 2 iterations · $0.20` (and the
other exit-reason lines), now within the card; the next-action + deferred-followup
lines remain.

## Task 4 — `console-ui.ts` + runner sink (quiet-by-default in-run console)

NEW `packages/core/src/console-ui.ts`: an **event sink** interface
`{ setStage(iteration, stage): void; onEvent(ev: StreamJson): void }` with two
implementations — a quiet `ConsoleUi` and a `VerboseSink` that delegates to the
existing `renderEvent`. The quiet renderer classifies a parsed event into a
meaningful action and prints ONE concise line: **edit** (`Edit`/`Write` → path),
**commit** (Bash whose `command` contains `git commit` → the subject), **test**
(Bash command matching `pnpm test|pnpm run test|vitest|tsc|node --test|dotnet
test|pytest` → pass/fail summarized from the paired `tool_result`), **error**
(`is_error` → the tool + a short snippet); suppress assistant text and
`Read`/`Glob`/`Grep`. Print a per-stage header on `setStage`. Refactor
`runner.ts:711` to call an injected sink (`opts.sink?.onEvent(parsed)` ?? the
current `renderEvent`) so the renderer is selectable without changing the
streaming/parse logic; the loop sets `setStage` before each stage. Keep the codex
path (`renderCodexEvent`) unchanged. Honor `NO_COLOR`/non-TTY. → verify:
`console-ui.test.ts` — synthetic events: an `Edit` and a `git commit` Bash and a
`pnpm test` result and an `is_error` each emit their line; an assistant text block
and a `Read` emit nothing in quiet mode; `setStage` prints the header; the verbose
sink delegates to `renderEvent`. Update `runner.test.ts` for the injected sink.

## Task 5 — `--verbose` flag + `otto-tail` bin

Two surfaces.
- **`--verbose`**: parse in `cli-help.ts` (`cfg.verbose`), thread through
  `run-bin.ts` → `runLoop` → the runner so the loop picks the verbose sink; shown
  by `--print-config`. → verify: `cli-help.test.ts` + `run-bin.test.ts`.
- **`otto-tail`**: NEW `packages/core/src/tail.ts` `runTail(argv, deps: TailDeps)`
  mirroring `inspect.ts`'s shape — resolve `<run-id>|latest` via `listRunIds`,
  poll `.otto/runs/<id>/` on an interval (injectable `sleep`/`now`/max-polls so
  tests never really wait), re-render `formatLiveTree` while running and
  `formatDoneCard` once `manifest.finishedAt` is set, then return 0; unknown id /
  no runs → err + exit 1. NEW `apps/cli/bin/otto-tail.js` (mirrors
  `otto-inspect.js`) + the `package.json` bin entry. Export `runTail`/`TailDeps`
  from `index.ts`; document `otto-tail` + quiet/`--verbose` in `README.md`. →
  verify: `tail.test.ts` — latest resolution, live-tree for an in-progress
  manifest, done-card once finalized, unknown-id error, deterministic polling via
  injected deps.

## Task 6 — Record the slice

Append a terse P10 bullet to `.otto/LEARNINGS.md` and write a governed-memory
record under `.otto/memory/`, in the final work commit. → verify: files present;
full `pnpm -r typecheck && pnpm -r test && pnpm test` green; `smoke-templates`
under budget.

## Deferred follow-ups (named, not in this PR)

- A full-screen TUI redraw (alternate-screen dashboard) for an even more
  glanceable live view.
- An HTTP/HTML live page or live-updating markdown, if a browser view is wanted.
- A persisted per-action event log in the bundle so `otto-tail` can show
  fine-grained actions (not just bundle-level stage/total/plan progress).
- Surfacing the adaptive-router decision inline in the quiet console.
