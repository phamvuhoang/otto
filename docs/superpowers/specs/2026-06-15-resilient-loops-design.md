# Design: resilient long-running AFK loops (rate-limit wait + resumption)

Date: 2026-06-15
Status: Approved (brainstorm), pending spec review → implementation plan
Applies to: both `otto-afk` and `otto-ghafk` (mode-agnostic — operates at the loop/runner layer).

## Problem

A long AFK run dies badly in two ways, both observed live (Adventory, a 30-iteration run):

1. **Session/rate limit churns the loop dry.** When the account hits its 5-hour
   limit, `claude` emits a `result` event (`is_error:true`, `api_error_status:429`,
   `result:"You've hit your session limit · resets 4:50pm (Asia/Saigon)"`) and a
   `rate_limit_event` (`rate_limit_info.resetsAt: <unix>`, `rateLimitType:"five_hour"`,
   `status:"rejected"`), then **exits with code 1**. Today `runner.ts` rejects on any
   non-zero exit with a generic `claude exited with 1`, discarding the captured
   `result`. `withRetries` then burns 3 short retries (`5s/30s/120s`) — useless against
   a multi-hour window — the iteration `break`s, and the **next iteration starts
   immediately and fails the same way**. The whole run is wasted, and the exact reset
   time (`resetsAt`) is ignored.

2. **No resumption after a process death.** If the PC restarts, the user kills the run,
   or it crashes, re-running the same command restarts from iteration 1. Work is
   committed per iteration and the plan file tracks tasks, but nothing marks "we were
   mid-run", and — as a real execution report showed — **plan checkboxes are unreliable**
   (code was committed but `[ ]` boxes never flipped). The agent _can_ reconcile true
   progress from git history + the working tree, but there's no guarantee it does, so
   re-runs risk redoing work.

## Decisions (locked in brainstorm)

- On limit: **wait until reset, then resume** the same loop (not halt). Cap the wait;
  if the cap is exceeded, halt cleanly.
- Resumption is **two layers**: a git-reconciliation safety net (authoritative, always
  on) + an advisory `state.json` pointer (resume awareness, iteration math, rate-limit
  persistence). State mismatch/absence must **never** cause blind rework or an error.
- `state.json` records a `mode` field now so the future verify/review modes (out of
  scope here — see Future work) slot in without a format change.

## Scope guard

Building: rate-limit detection + wait-until-reset, `state.json` advisory resume, the
reconciliation playbook change, `--max-wait` / `--fresh` flags. **Not** building: a
full per-stage journal, multi-run history, cross-machine sync, or the verify/review
run modes (separate specs). `state.json` is single-workspace advisory; **git is the
source of truth** for what's done.

---

## Part A — Detect & wait out the session/rate limit

### A1. Runner surfaces the limit (`runner.ts` + new `rate-limit.ts`)

New module `packages/core/src/rate-limit.ts` (pure, unit-tested):

```ts
export class RateLimitError extends Error {
  readonly resetsAt: number | null; // unix seconds, or null if not reported
  constructor(message: string, resetsAt: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.resetsAt = resetsAt;
  }
}

/** resetsAt (unix s) from a rate_limit_event, else null. */
export function resetsAtFromEvent(ev: unknown): number | null;

/** True if a `result` event signals a usage/session/rate limit
 *  (is_error && api_error_status 429, or the "session limit" result text). */
export function isLimitResult(result: StageResult): boolean;
```

`runner.ts` changes:

- While streaming, when a `rate_limit_event` with `status === "rejected"` is seen, store
  its `resetsAt` (latest wins) in a `lastResetsAt` local.
- On stage end, decide limit vs not:
  - If a `result` event was captured and `isLimitResult(final)` → throw
    `RateLimitError(final.result || "rate limit", lastResetsAt)`. (`resetsAt` comes only
    from the `rate_limit_event` via `resetsAtFromEvent`; the `result` event carries just
    the 429/message signal, so `lastResetsAt` may be `null` → A3 falls back to a fixed wait.)
  - Else keep today's behavior: code 0 → `resolveOnce(final)`; non-zero → reject with
    `claude exited with <code>`.
- This means a limit is reported as `RateLimitError` **whether claude exits 0 or 1** —
  the captured `result`/`rate_limit_event` is the signal, not the exit code.

`StageResult` is unchanged; a limit no longer masquerades as a generic failure.

### A2. Don't waste retries (`retry.ts`)

`withRetries` already rethrows `AbortError` immediately. Add the same for
`RateLimitError`:

```ts
if ((err as Error)?.name === "AbortError") throw err;
if ((err as Error)?.name === "RateLimitError") throw err; // waited for in loop.ts, not retried
```

A unit test asserts a thrown `RateLimitError` is not retried (call count == 1).

### A3. Wait-until-reset in the loop (`loop.ts`)

Wrap the per-stage execution (both the `executeStage` and `runPanel` paths) in a
rate-limit-aware retry:

```
runStageWithRateLimitWait(runOnce):
  for (;;) {
    try { return await runOnce(); }
    catch (err) {
      if (err.name !== "RateLimitError") throw err;   // normal path unchanged
      const waitMs = computeWaitMs(err.resetsAt, now(), RATE_LIMIT_BUFFER_MS, FALLBACK_WAIT_MS);
      if (waitMs > maxWaitMs) {
        writeState({ ...state, status: "interrupted" });
        print "✗ rate limit; reset is beyond --max-wait (<cap>); halting — re-run to resume";
        throw err;   // bubbles to the existing catch → clean stop
      }
      writeState({ ...state, status: "waiting-rate-limit", resetsAt: err.resetsAt });
      print "⏸ rate limit — waiting <h m> until reset, then resuming";
      await sleep(waitMs, activeSignal);   // abortable: Ctrl-C / daemon signal still work; wake-lock held
      // loop: retry the SAME stage at the SAME iteration index
    }
  }
```

- `computeWaitMs(resetsAt, now, buffer, fallback)` (pure, tested): `resetsAt != null`
  → `max(0, resetsAt*1000 − now + buffer)`; else `fallback`. `buffer` ≈ 30s so we
  don't wake a hair early. `fallback` ≈ 15m when the limit gave no `resetsAt`.
- New flag **`--max-wait <duration>`** / env `OTTO_MAX_WAIT`, default **6h** (covers a
  5-hour window with margin). Accepts `<N>` (seconds) or a suffixed duration
  (`90m`, `6h`) — parsed by a small helper; matches the validation style in `cli-help.ts`.
- The wait holds the wake-lock (already acquired for the loop's life) and is abortable,
  so SIGINT → 130 still exits promptly and the watch-daemon signal still interrupts.
- Cost accounting is unaffected: a limit `result` has `total_cost_usd: 0`.

---

## Part B — Idempotent resumption

### B1. Safety net — playbook reconciliation (authoritative, always on)

Edit `templates/prompt.md` (afk) and `templates/ghprompt-workflow.md` (ghafk),
TASK SELECTION section. Add, in substance:

> Before selecting a task, reconcile the plan against reality: check recent `git log`
> and the working tree to determine which tasks are **already implemented and committed**.
> Treat plan-file checkboxes as hints, **not** truth — code that is present and committed
> is done even if its box is unticked. Skip anything already done. When you complete or
> confirm a task, flip its checkbox as part of your commit so the plan converges to truth.

This is what actually prevents rework. It holds with no `state.json`, a wiped
`.otto-tmp/`, a fresh clone, or a mismatched command — so even a worst-case "restart
from iteration 1" costs at most one cheap verification pass, never real rework. (Directly
fixes the stale-`[ ]` problem the execution report surfaced.)

### B2. Advisory pointer — `state.json` (new `state.ts`, managed by `loop.ts`)

`<effectiveWorkspaceDir>/.otto/state.json`, **gitignored**:

```json
{
  "bin": "otto-afk",
  "mode": "afk",
  "inputs": "<plan-and-prd>",
  "iteration": 11,
  "of": 30,
  "status": "running | waiting-rate-limit | interrupted | complete",
  "resetsAt": 1781517000,
  "startedAt": "...",
  "updatedAt": "..."
}
```

New module `packages/core/src/state.ts` (pure I/O + match logic, unit-tested):

```ts
export type RunStatus =
  | "running"
  | "waiting-rate-limit"
  | "interrupted"
  | "complete";
export type RunState = {
  bin: string;
  mode: string;
  inputs: string;
  iteration: number;
  of: number;
  status: RunStatus;
  resetsAt?: number | null;
  startedAt: string;
  updatedAt: string;
};
export function readState(workspaceDir: string): RunState | null; // absent/malformed → null
export function writeState(workspaceDir: string, s: RunState): void; // mkdir .otto, write
export function clearState(workspaceDir: string): void; // rm, ignore ENOENT
/** Resume iff a prior unfinished run matches this invocation. */
export function matchesResume(
  prev: RunState | null,
  cur: { bin: string; mode: string; inputs: string }
): boolean;
// matches = prev != null && prev.status !== "complete" && bin+mode+inputs all equal
```

- **`mode`** = `"afk"` / `"ghafk"` today (passed from the bin via `RunBinConfig`);
  carries the future verify/review modes without a format change.
- Lives in `.otto/` (Otto's durable home) but **gitignored** — extend the startup
  gitignore helper (from the branch-strategy feature) to ensure BOTH `.otto-tmp/` and
  `.otto/state.json` are ignored. `git commit -am` wouldn't stage it regardless; this
  keeps `git status` clean.

`run-bin.ts` / `loop.ts` wiring:

- At startup (after `resolveBranch`, before the loop), `loop.ts` reads prior state and
  resolves start position:
  - `--fresh` → `clearState`, start at iteration 1, run the new `N`.
  - else if `matchesResume(prev, {bin, mode, inputs})` → **resume**: start at
    `prev.iteration`, total = `prev.of` (the original ceiling), set `RESUME` note (B3),
    print `▶ resuming from iteration <iter>/<of>`. If `prev.status === "waiting-rate-limit"`
    and `prev.resetsAt` is in the future, wait the remainder (A3's `sleep`) before the
    first stage; if already past, start immediately.
  - else (absent/mismatch) → start at iteration 1, run the new `N`, overwrite state.
- The loop writes state at each iteration boundary (`status:"running"`, current
  `iteration`/`of`) and on the A3 transitions.
- On sentinel completion → `writeState({status:"complete"})` then `clearState`
  (completed runs don't trigger a phantom resume). On SIGINT/SIGTERM the existing
  handler may leave `status:"running"`/`"waiting-rate-limit"`; that's correct — a later
  re-run resumes.

The iteration loop bound becomes `for (let i = startIteration; i <= total; i++)`. Because
B1 makes every pass idempotent, an over- or under-count is safe (it just changes how many
reconcile passes run), so resume math needs no perfection.

### B3. Resume awareness in the prompt — `{{ RESUME }}` tag

`render.ts` gains a `{{ RESUME }}` expansion (empty string on fresh runs). On a resumed
run, `loop.ts` passes a one-line note rendered into the iteration templates
(`afk.md` / `ghafk.md`), e.g.:

> Resumed run (iteration 11 of 30). Prior work is committed — reconcile against git
> history and the working tree before acting; do not redo completed tasks.

Minimal plumbing: `RESUME` joins `INPUTS` in the `vars` map passed to `executeStage`;
`afk.md`/`ghafk.md` get a `{{ RESUME }}` slot near the top. The substance is B1; this is
just operator/agent awareness.

---

## Components / file map

- **New** `packages/core/src/rate-limit.ts` (+ `__tests__/rate-limit.test.ts`) —
  `RateLimitError`, `resetsAtFromEvent`, `isLimitResult`, `computeWaitMs`.
- **New** `packages/core/src/state.ts` (+ `__tests__/state.test.ts`) — `RunState` I/O + `matchesResume`.
- **Edit** `runner.ts` — capture `resetsAt`; throw `RateLimitError` on limit (exit-code-agnostic).
- **Edit** `retry.ts` — rethrow `RateLimitError`.
- **Edit** `loop.ts` — rate-limit-wait wrapper; state read/write + resume start position; `{{ RESUME }}` var; `maxWaitMs`/`mode` options.
- **Edit** `render.ts` — `{{ RESUME }}` expansion.
- **Edit** `cli-help.ts` / `run-bin.ts` — `--max-wait`, `--fresh` flags + env; `--print-config` lines; pass `mode` (from `RunBinConfig`) + `maxWaitMs` into `runLoop`.
- **Edit** gitignore helper — also ensure `.otto/state.json`.
- **Edit** `templates/prompt.md`, `templates/ghprompt-workflow.md` — B1 reconciliation; `{{ RESUME }}` slot in `afk.md`/`ghafk.md`.
- **Docs** — README (flags/env + a "Resilience & resume" note), `docs/ARCHITECTURE.md`.

## Testing

Pure units (no real waits — inject clock/sleep):

- `rate-limit.ts`: `isLimitResult` / `resetsAtFromEvent` against the **real** NDJSON
  shapes from the Adventory log (429 result + rejected `rate_limit_event`); `computeWaitMs`
  with `resetsAt` present/absent and past/future; `maxWait` boundary.
- `retry.ts`: `RateLimitError` thrown once → not retried (fn called once).
- `state.ts`: read absent/malformed → null; write+read round-trip; `matchesResume`
  for match / status-complete / bin|mode|inputs mismatch / null.
- `loop.ts`: a fake stage throwing `RateLimitError` once (with a near-future `resetsAt`)
  → asserts state goes `waiting-rate-limit`, an injected `sleep` is called with the
  computed ms, then the same stage/iteration retries and succeeds; a second fake whose
  `resetsAt` exceeds `maxWait` → halts cleanly (state `interrupted`, loop returns).
- Resume: seed a matching `state.json` at iteration 11/30 → loop starts at 11; seed a
  mismatched one → starts at 1; `--fresh` → clears + starts at 1.

`pnpm -r typecheck && pnpm -r test && pnpm test` stays green; real smoke is hard for the
live limit, so coverage is via injected clock/sleep + the recorded NDJSON fixtures.

## Future work (separate specs, enabled by this one)

- **Verify mode** (read-only re-verification): a run that reconciles plan vs git +
  runs the test suites + emits a report, makes no commits; reuses B1's reconciliation
  and this resilience layer. `state.json` `mode: "verify"`.
- **Review-driven mode**: input = a code-review document; triage findings by
  actionability/severity, fix actionable ones (commit per fix), gate on "no actionable
  findings left"; distinct from the existing `--review-panel`. `state.json` `mode: "review"`.
