# Resilient Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long AFK runs survive the session/rate limit (wait until reset, then resume the same iteration) and survive process death (re-running continues instead of redoing committed work).

**Architecture:** A new pure `rate-limit.ts` detects the limit from the claude stream and carries the reset time in a typed `RateLimitError`; `runner.ts` throws it regardless of exit code; `retry.ts` refuses to retry it; `loop.ts` waits until reset (capped by `--max-wait`) then retries the same stage. A new pure `state.ts` persists an advisory `.otto/state.json` (gitignored) so a re-run resumes from the right iteration, while a playbook change makes the implementer reconcile against git so re-runs never redo committed work.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), vitest. `runStage`/`sleep` are mockable (see `loop.test.ts`).

Spec: `docs/superpowers/specs/2026-06-15-resilient-loops-design.md`.

**Conventions:** ESM-only, relative imports end in `.js`. Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit hook runs prettier + typecheck. `pnpm -r build` before any bin smoke (cli imports `dist/`).

---

## File Structure

- **New** `packages/core/src/rate-limit.ts` — `RateLimitError`, `isLimitResult`, `resetsAtFromEvent`, `computeWaitMs` (pure).
- **New** `packages/core/src/state.ts` — `RunState`, `readState`/`writeState`/`clearState`/`matchesResume` (pure I/O).
- **New** tests `__tests__/rate-limit.test.ts`, `__tests__/state.test.ts`.
- **Modify** `runner.ts` — capture `resetsAt`; throw `RateLimitError` on limit (exit-code-agnostic).
- **Modify** `retry.ts` — rethrow `RateLimitError`.
- **Modify** `loop.ts` — rate-limit-wait wrapper; state read/write + resume start position; `RESUME` var; `mode`/`maxWaitMs` options.
- **Modify** `cli-help.ts` / `run-bin.ts` — `--max-wait` / `--fresh` + env; `--print-config`; thread `mode`/`maxWaitMs`.
- **Modify** `render`-consumed templates `templates/afk.md`, `templates/ghafk.md` (add `{{ RESUME }}` slot); `templates/prompt.md`, `templates/ghprompt-workflow.md` (B1 reconciliation).
- **Modify** branch-strategy gitignore helper — also ignore `.otto/state.json`.
- **Modify** `README.md`, `docs/ARCHITECTURE.md`.
- **Modify** `main.ts` / `gh-main.ts` + `run-bin.ts` `RunBinConfig` — add `mode`.

> NOTE ON BASE BRANCH: this branch (`feat/resilient-loops`) is cut from `main`, which does NOT yet contain the branch-strategy feature (`branch.ts`, `git.ts`, `ensureTmpIgnored`). Task 7 Step "gitignore state.json" assumes those exist. If `ensureTmpIgnored` is absent at implementation time, implement the `.otto/state.json` ignore as a small standalone helper here instead, and note it for later reconciliation. Check first: `ls packages/core/src/git.ts packages/core/src/branch.ts`.

---

## Task 1: `rate-limit.ts` — pure detection + error + wait math

**Files:**

- Create: `packages/core/src/rate-limit.ts`
- Create: `packages/core/src/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test** at `packages/core/src/__tests__/rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  RateLimitError,
  computeWaitMs,
  isLimitResult,
  resetsAtFromEvent,
} from "../rate-limit.js";

describe("RateLimitError", () => {
  it("has name RateLimitError and carries resetsAt", () => {
    const e = new RateLimitError("limit", 1781517000);
    expect(e.name).toBe("RateLimitError");
    expect(e.resetsAt).toBe(1781517000);
    expect(e instanceof Error).toBe(true);
  });
});

describe("isLimitResult", () => {
  it("true when is_error and api_error_status 429", () => {
    expect(
      isLimitResult({
        result: "x",
        costUsd: 0,
        isError: true,
        apiErrorStatus: "429",
      })
    ).toBe(true);
  });
  it("true on the session-limit result text even without 429", () => {
    expect(
      isLimitResult({
        result: "You've hit your session limit · resets 4:50pm (Asia/Saigon)",
        costUsd: 0,
        isError: true,
        apiErrorStatus: null,
      })
    ).toBe(true);
  });
  it("false for a normal successful result", () => {
    expect(
      isLimitResult({
        result: "done",
        costUsd: 0.1,
        isError: false,
        apiErrorStatus: null,
      })
    ).toBe(false);
  });
  it("false for a non-limit error (e.g. 500)", () => {
    expect(
      isLimitResult({
        result: "boom",
        costUsd: 0,
        isError: true,
        apiErrorStatus: "500",
      })
    ).toBe(false);
  });
});

describe("resetsAtFromEvent", () => {
  it("extracts resetsAt from a rejected rate_limit_event", () => {
    const ev = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1781517000,
        rateLimitType: "five_hour",
      },
    };
    expect(resetsAtFromEvent(ev)).toBe(1781517000);
  });
  it("returns null when not a rate_limit_event or no resetsAt", () => {
    expect(resetsAtFromEvent({ type: "result" })).toBeNull();
    expect(
      resetsAtFromEvent({ type: "rate_limit_event", rate_limit_info: {} })
    ).toBeNull();
    expect(resetsAtFromEvent(null)).toBeNull();
  });
});

describe("computeWaitMs", () => {
  const now = 1_000_000_000_000; // ms
  it("waits until resetsAt plus buffer", () => {
    const resetsAt = Math.floor(now / 1000) + 600; // +10 min
    expect(computeWaitMs(resetsAt, now, 30_000, 900_000)).toBe(
      600_000 + 30_000
    );
  });
  it("never negative when resetsAt already passed", () => {
    const resetsAt = Math.floor(now / 1000) - 600;
    expect(computeWaitMs(resetsAt, now, 30_000, 900_000)).toBe(0);
  });
  it("uses the fallback when resetsAt is null", () => {
    expect(computeWaitMs(null, now, 30_000, 900_000)).toBe(900_000);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- rate-limit.test`
Expected: FAIL — cannot find module `../rate-limit.js`.

- [ ] **Step 3: Create `packages/core/src/rate-limit.ts`**

```ts
import type { StageResult } from "./runner.js";

/** Thrown when a stage hit a usage/session/rate limit. `resetsAt` is unix seconds
 *  (from the rate_limit_event) or null if the limit gave no reset time. */
export class RateLimitError extends Error {
  readonly resetsAt: number | null;
  constructor(message: string, resetsAt: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.resetsAt = resetsAt;
  }
}

/** True if a `result` event signals a usage/session/rate limit:
 *  is_error with an HTTP 429, or the CLI's "session limit" result text. */
export function isLimitResult(r: StageResult): boolean {
  if (!r.isError) return false;
  if (r.apiErrorStatus != null && /429/.test(r.apiErrorStatus)) return true;
  return /session limit|usage limit|rate.?limit/i.test(r.result);
}

/** resetsAt (unix seconds) from a `rate_limit_event`, else null. */
export function resetsAtFromEvent(ev: unknown): number | null {
  const e = (ev ?? {}) as Record<string, unknown>;
  if (e.type !== "rate_limit_event") return null;
  const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
  return typeof info.resetsAt === "number" ? info.resetsAt : null;
}

/** Milliseconds to wait before retrying. With a resetsAt: time until it + buffer
 *  (never negative). Without: the fallback. */
export function computeWaitMs(
  resetsAt: number | null,
  nowMs: number,
  bufferMs: number,
  fallbackMs: number
): number {
  if (resetsAt == null) return fallbackMs;
  return Math.max(0, resetsAt * 1000 - nowMs + bufferMs);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- rate-limit.test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/rate-limit.ts packages/core/src/__tests__/rate-limit.test.ts
git commit -m "feat(core): rate-limit detection helpers + RateLimitError"
```

---

## Task 2: `runner.ts` — throw RateLimitError on limit (exit-code-agnostic)

**Files:**

- Modify: `packages/core/src/runner.ts` (the `rl.on("line")` handler ~`runner.ts:305-340`, the grace-timer callback, and `child.on("close")` ~`runner.ts:358-365`)

There is no unit test for the spawn path today (only the pure helpers are tested). The decision predicate `isLimitResult` is fully covered by Task 1; this task wires it in. Verify via typecheck + existing `runner.test` staying green.

- [ ] **Step 1: Add imports + a captured-reset local**

At the top of `runner.ts`, add:

```ts
import {
  RateLimitError,
  isLimitResult,
  resetsAtFromEvent,
} from "./rate-limit.js";
```

Inside `runStage`'s returned `new Promise(...)`, near the other locals (e.g. beside `final`/`stderrTail`), add:

```ts
let lastResetsAt: number | null = null;
```

- [ ] **Step 2: Capture resetsAt while streaming**

In the `rl.on("line", ...)` handler, after `renderEvent(parsed, toolMap);` and alongside the existing `if (parsed.type === "result")` block, add:

```ts
if (parsed.type === "rate_limit_event") {
  const r = resetsAtFromEvent(parsed);
  if (r != null) lastResetsAt = r;
}
```

- [ ] **Step 3: Throw RateLimitError when the result is a limit**

Replace the `child.on("close", (code) => { ... })` body with:

```ts
child.on("close", (code) => {
  if (final && isLimitResult(final)) {
    rejectOnce(new RateLimitError(final.result || "rate limit", lastResetsAt));
    return;
  }
  if (code !== 0) {
    rejectOnce(
      new Error(`claude exited with ${code}\n${stderrTail.join("\n")}`)
    );
    return;
  }
  resolveOnce(final);
});
```

And in the grace-timer callback, change the terminal `resolveOnce(final);` so a limit still surfaces as a `RateLimitError`:

```ts
if (final && isLimitResult(final)) {
  rejectOnce(new RateLimitError(final.result || "rate limit", lastResetsAt));
} else {
  resolveOnce(final);
}
```

(Replace the single `resolveOnce(final);` inside the `graceTimer = setTimeout(...)` callback with the above; keep the `child.kill()` that precedes it.)

- [ ] **Step 4: Verify**

Run: `pnpm --filter @phamvuhoang/otto-core test -- runner.test && pnpm -r typecheck`
Expected: PASS (existing runner tests unaffected; typecheck clean). Confirm no circular-import error — `rate-limit.ts` uses `import type { StageResult }` (type-only, erased), so there's no runtime cycle with `runner.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runner.ts
git commit -m "feat(core): runner throws RateLimitError on session/rate limit"
```

---

## Task 3: `retry.ts` — never retry a RateLimitError

**Files:**

- Modify: `packages/core/src/retry.ts` (the catch block in `withRetries`)
- Modify: `packages/core/src/__tests__/retry.test.ts`

- [ ] **Step 1: Add a failing test** — append to `retry.test.ts`:

```ts
import { RateLimitError } from "../rate-limit.js";

it("does not retry a RateLimitError (rethrows immediately)", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new RateLimitError("limit", 123);
  };
  await expect(
    withRetries(fn, { max: 3, backoffMs: [1, 1, 1], sleep: async () => {} })
  ).rejects.toBeInstanceOf(RateLimitError);
  expect(calls).toBe(1);
});
```

(Confirm `withRetries` is already imported at the top of `retry.test.ts`; if not, add it.)

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- retry.test`
Expected: FAIL — `calls` is 4 (it retried).

- [ ] **Step 3: Implement** — in `retry.ts`, in the `catch (err)` block, just after the existing AbortError line:

```ts
if ((err as Error)?.name === "AbortError") throw err;
if ((err as Error)?.name === "RateLimitError") throw err;
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- retry.test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry.ts packages/core/src/__tests__/retry.test.ts
git commit -m "feat(core): withRetries rethrows RateLimitError without retrying"
```

---

## Task 4: `state.ts` — advisory run-state I/O

**Files:**

- Create: `packages/core/src/state.ts`
- Create: `packages/core/src/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test** at `packages/core/src/__tests__/state.test.ts`:

```ts
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearState,
  matchesResume,
  readState,
  writeState,
  type RunState,
} from "../state.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-state-"));
}
const sample: RunState = {
  bin: "otto-afk",
  mode: "afk",
  inputs: "plan prd",
  iteration: 11,
  of: 30,
  status: "running",
  resetsAt: null,
  startedAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

describe("state I/O", () => {
  it("returns null when absent", () => {
    expect(readState(tmp())).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    const d = tmp();
    mkdirSync(join(d, ".otto"));
    writeFileSync(join(d, ".otto", "state.json"), "{ nope");
    expect(readState(d)).toBeNull();
  });
  it("round-trips a write", () => {
    const d = tmp();
    writeState(d, sample);
    expect(readState(d)).toEqual(sample);
  });
  it("clearState removes the file and is safe when absent", () => {
    const d = tmp();
    writeState(d, sample);
    clearState(d);
    expect(existsSync(join(d, ".otto", "state.json"))).toBe(false);
    expect(() => clearState(d)).not.toThrow();
  });
});

describe("matchesResume", () => {
  const cur = { bin: "otto-afk", mode: "afk", inputs: "plan prd" };
  it("true for an unfinished run with matching identity", () => {
    expect(matchesResume(sample, cur)).toBe(true);
  });
  it("false when prior run completed", () => {
    expect(matchesResume({ ...sample, status: "complete" }, cur)).toBe(false);
  });
  it("false on bin/mode/inputs mismatch", () => {
    expect(matchesResume({ ...sample, inputs: "other" }, cur)).toBe(false);
    expect(matchesResume({ ...sample, mode: "ghafk" }, cur)).toBe(false);
    expect(matchesResume({ ...sample, bin: "otto-ghafk" }, cur)).toBe(false);
  });
  it("false when there is no prior state", () => {
    expect(matchesResume(null, cur)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- state.test`
Expected: FAIL — cannot find module `../state.js`.

- [ ] **Step 3: Create `packages/core/src/state.ts`**

```ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const STATE_REL = join(".otto", "state.json");

/** Read .otto/state.json. Absent or malformed → null (never throws). */
export function readState(workspaceDir: string): RunState | null {
  try {
    return JSON.parse(
      readFileSync(join(workspaceDir, STATE_REL), "utf8")
    ) as RunState;
  } catch {
    return null;
  }
}

/** Write .otto/state.json (creates .otto/). */
export function writeState(workspaceDir: string, s: RunState): void {
  mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
  writeFileSync(
    join(workspaceDir, STATE_REL),
    JSON.stringify(s, null, 2) + "\n"
  );
}

/** Remove .otto/state.json; ignore if absent. */
export function clearState(workspaceDir: string): void {
  rmSync(join(workspaceDir, STATE_REL), { force: true });
}

/** Resume iff a prior unfinished run matches this invocation's identity. */
export function matchesResume(
  prev: RunState | null,
  cur: { bin: string; mode: string; inputs: string }
): boolean {
  return (
    prev != null &&
    prev.status !== "complete" &&
    prev.bin === cur.bin &&
    prev.mode === cur.mode &&
    prev.inputs === cur.inputs
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- state.test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/state.ts packages/core/src/__tests__/state.test.ts
git commit -m "feat(core): advisory run-state read/write/match (.otto/state.json)"
```

---

## Task 5: `loop.ts` — wait-until-reset + resume + RESUME var

**Files:**

- Modify: `packages/core/src/loop.ts`
- Modify: `packages/core/src/__tests__/loop.test.ts`

This is the integration task. `loop.test.ts` mocks `runStage` (so a thrown `RateLimitError` propagates through `executeStage`) and `sleep` (so no real waits). `state.json` is written under `workspaceDir/.otto/` and read back in tests.

- [ ] **Step 1: Add failing tests** — append inside `describe("runLoop", ...)` in `loop.test.ts`:

```ts
it("waits until reset then retries the same stage on a RateLimitError", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  const { RateLimitError } = await import("../rate-limit.js");
  const future = Math.floor(Date.now() / 1000) + 600; // +10 min
  mocks.runStage
    .mockRejectedValueOnce(new RateLimitError("session limit", future))
    .mockResolvedValueOnce(ok(sentinel));

  await runLoop(loopOptions(dirs, { mode: "afk", bin: "otto-afk" }));

  expect(mocks.sleep).toHaveBeenCalled();
  const waited = Number(mocks.sleep.mock.calls.at(-1)?.[0]);
  expect(waited).toBeGreaterThan(0);
  expect(mocks.runStage).toHaveBeenCalledTimes(2); // waited, then retried same stage
});

it("halts cleanly when the reset is beyond maxWaitMs", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  const { RateLimitError } = await import("../rate-limit.js");
  const far = Math.floor(Date.now() / 1000) + 10 * 3600; // +10h
  mocks.runStage.mockRejectedValue(new RateLimitError("session limit", far));

  const outcome = await runLoop(
    loopOptions(dirs, {
      mode: "afk",
      bin: "otto-afk",
      maxWaitMs: 6 * 3600_000,
    })
  );

  expect(outcome.sentinelHit).toBe(false);
  expect(mocks.runStage).toHaveBeenCalledTimes(1); // no wait, no retry
  const { readState } = await import("../state.js");
  expect(readState(dirs.workspaceDir)?.status).toBe("interrupted");
});

it("resumes from the saved iteration when state matches", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  const { writeState } = await import("../state.js");
  writeState(dirs.workspaceDir, {
    bin: "otto-afk",
    mode: "afk",
    inputs: "plan",
    iteration: 3,
    of: 5,
    status: "running",
    startedAt: "x",
    updatedAt: "x",
  });
  mocks.runStage.mockResolvedValue(ok("still working")); // never hits sentinel

  await runLoop(
    loopOptions(dirs, { mode: "afk", bin: "otto-afk", iterations: 5 })
  );

  // resumed 3→5 ⇒ 3 iterations, not 5
  expect(mocks.runStage).toHaveBeenCalledTimes(3);
});

it("clears state on sentinel completion", async () => {
  const dirs = makeDirs();
  roots.push(dirs.root);
  mocks.runStage.mockResolvedValue(ok(sentinel));
  await runLoop(loopOptions(dirs, { mode: "afk", bin: "otto-afk" }));
  const { readState } = await import("../state.js");
  expect(readState(dirs.workspaceDir)).toBeNull();
});
```

- [ ] **Step 2: Run, verify the new tests fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop.test`
Expected: FAIL (new options/behavior not implemented).

- [ ] **Step 3: Extend `LoopOptions`** in `loop.ts`:

```ts
  /** Run mode for state.json identity (e.g. "afk" / "ghafk"). Default "afk". */
  mode?: string;
  /** Cap on the rate-limit wait before halting. Default 6h. */
  maxWaitMs?: number;
  /** Force a fresh run, ignoring/clearing prior state. Default false. */
  fresh?: boolean;
```

- [ ] **Step 4: Add imports + constants** at the top of `loop.ts`:

```ts
import { RateLimitError, computeWaitMs } from "./rate-limit.js";
import {
  clearState,
  matchesResume,
  readState,
  writeState,
  type RunState,
} from "./state.js";

const RATE_LIMIT_BUFFER_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 6 * 3600_000;
```

- [ ] **Step 5: Resolve start position + total before the loop**

Destructure the new options (`mode = "afk"`, `maxWaitMs = DEFAULT_MAX_WAIT_MS`, `fresh = false`) alongside the existing ones. Then, just before `let completedIterations = 0;`, add:

```ts
const nowIso = () => new Date().toISOString();
if (fresh) clearState(workspaceDir);
const prior = fresh ? null : readState(workspaceDir);
const resuming = matchesResume(prior, { bin, mode, inputs });
const startIteration = resuming ? prior!.iteration : 1;
const total = resuming ? prior!.of : iterations;
let resumeNote = "";
if (resuming) {
  resumeNote = `Resumed run (iteration ${startIteration} of ${total}). Prior work is committed — reconcile against git history and the working tree before acting; do not redo completed tasks.`;
  process.stdout.write(
    `${greenOut(SYM_OUT.bullet)} ${boldOut("resuming")}${dimOut(` from iteration ${startIteration}/${total}`)}\n`
  );
}
const persist = (
  iteration: number,
  status: RunState["status"],
  resetsAt?: number | null
) =>
  writeState(workspaceDir, {
    bin,
    mode,
    inputs,
    iteration,
    of: total,
    status,
    resetsAt: resetsAt ?? null,
    startedAt: prior?.startedAt ?? nowIso(),
    updatedAt: nowIso(),
  });
```

If `resuming` and `prior!.status === "waiting-rate-limit"` and `prior!.resetsAt` is in the future, wait the remainder before the loop:

```ts
if (resuming && prior!.status === "waiting-rate-limit") {
  const waitMs = computeWaitMs(
    prior!.resetsAt ?? null,
    Date.now(),
    RATE_LIMIT_BUFFER_MS,
    0
  );
  if (waitMs > 0 && waitMs <= maxWaitMs) {
    process.stderr.write(
      `${dim(`waiting ${Math.round(waitMs / 60000)}m to clear the prior rate limit`)}\n`
    );
    await sleep(waitMs, activeSignal);
  }
}
```

- [ ] **Step 6: Change the iteration bound and persist per iteration**

Change `for (let i = 1; i <= iterations; i++) {` to:

```ts
    for (let i = startIteration; i <= total; i++) {
      persist(i, "running");
```

(The `persist(i, "running")` is the first line inside the `for`.)

- [ ] **Step 7: Wrap stage execution with rate-limit wait**

Replace the `let sr: StageResult;` + `try { ... } catch (err) { ... }` block that runs the stage with a version that waits on `RateLimitError`. The new shape (keep the existing panel/non-panel branches inside `runOnce`):

```ts
let sr: StageResult;
const runOnce = async (): Promise<StageResult> => {
  if (usePanel) {
    const { runPanel } = await import("./panel.js");
    return runPanel({
      lenses: reviewLenses!,
      workspaceDir,
      packageDir,
      iteration: i,
      maxRetries,
      cooldownMs,
      signal: activeSignal,
      onStage: accountStage,
    });
  }
  const r = await executeStage({
    stage,
    vars: { INPUTS: inputs, RESUME: resumeNote },
    workspaceDir,
    packageDir,
    iteration: i,
    maxRetries,
    signal: activeSignal,
  });
  accountStage(r);
  return r;
};

try {
  for (;;) {
    try {
      sr = await runOnce();
      break;
    } catch (err) {
      if ((err as Error)?.name !== "RateLimitError") throw err;
      const resetsAt = (err as RateLimitError).resetsAt;
      const waitMs = computeWaitMs(
        resetsAt,
        Date.now(),
        RATE_LIMIT_BUFFER_MS,
        RATE_LIMIT_FALLBACK_MS
      );
      if (waitMs > maxWaitMs) {
        persist(i, "interrupted", resetsAt);
        process.stdout.write(
          `${red(SYM.cross)} ${bold("rate limit")}${dim(` — reset is beyond --max-wait; halting at iteration ${i}. Re-run to resume.`)}\n`
        );
        return { costUsd: runCostUsd, sentinelHit };
      }
      persist(i, "waiting-rate-limit", resetsAt);
      const mins = Math.round(waitMs / 60000);
      process.stderr.write(
        `${dim(`⏸ rate limit — waiting ~${mins}m until reset, then resuming`)}\n`
      );
      await sleep(waitMs, activeSignal);
      persist(i, "running");
      // loop: retry the same stage at the same iteration
    }
  }
} catch (err) {
  if (activeSignal.aborted) {
    return { costUsd: runCostUsd, sentinelHit };
  }
  const stageLog = stageLogPath(workspaceDir, i, stage.name);
  const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
  try {
    appendFileSync(stageLog, failureMarker + "\n");
  } catch {
    // log file may be unwritable; stderr still carries the failure.
  }
  const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
  process.stderr.write(msg + "\n");
  break;
}
```

(Note: the `accountStage(sr)` that previously sat after the non-panel branch now lives inside `runOnce`; do not call it twice. The panel path still accounts via its `onStage`.)

- [ ] **Step 8: Clear state on completion**

In the `if (s === 0)` sentinel block, after `sentinelHit = true; completedIterations = i;` and before `return`, add:

```ts
persist(i, "complete");
clearState(workspaceDir);
```

Also, after the main `for` loop finishes all iterations naturally (just before the function's final `return { costUsd: runCostUsd, sentinelHit };` at the very end), add `clearState(workspaceDir);` so a fully-consumed iteration budget doesn't leave a stale resumable pointer. (Leave the SIGINT/`break`/abort paths as-is — they intentionally leave state for resume.)

- [ ] **Step 9: Run tests + typecheck**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop.test && pnpm -r typecheck`
Expected: PASS (new + existing loop tests green). If an existing test that asserts `runStage` call counts now also sees a `persist` write, that's fine — `persist` writes a file, it doesn't call `runStage`.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/__tests__/loop.test.ts
git commit -m "feat(core): wait-out rate limits + resume from state.json in the loop"
```

---

## Task 6: Templates — RESUME slot + reconciliation playbook (B1)

**Files:**

- Modify: `packages/core/templates/afk.md`, `packages/core/templates/ghafk.md` (add `{{ RESUME }}`)
- Modify: `packages/core/templates/prompt.md`, `packages/core/templates/ghprompt-workflow.md` (reconciliation)

No unit test (templates are content); verify with the `superpowers-include.test.ts` + a render smoke.

- [ ] **Step 1: Add the `{{ RESUME }}` slot.** At the very top of BOTH `templates/afk.md` and `templates/ghafk.md`, add a first line:

```
{{ RESUME }}
```

followed by a blank line, before the existing `<commits>` block. (`loop.ts` always passes `RESUME` — empty on fresh runs — so the tag never leaks as a literal.)

- [ ] **Step 2: Add reconciliation guidance to `templates/prompt.md`.** In the TASK SELECTION section (after the priority list, before EXPLORATION), insert:

```markdown
# RECONCILE BEFORE SELECTING

Before picking a task, reconcile the plan against reality. Check recent `git log` and the
working tree to see which tasks are **already implemented and committed**. Treat plan-file
checkboxes as hints, NOT truth — code that is present and committed is done even if its box
is unticked. Skip anything already done. When you complete or confirm a task, flip its
checkbox as part of your commit so the plan converges to the truth.
```

- [ ] **Step 3: Add the same to `templates/ghprompt-workflow.md`.** Find the equivalent task-selection area (it `@include`s into `ghafk.md`) and insert the same `# RECONCILE BEFORE SELECTING` block, but phrased for issues:

```markdown
# RECONCILE BEFORE SELECTING

Before picking an issue, reconcile against reality: check recent `git log` and the working
tree to see whether the work for an open issue is already implemented and committed. If it
is, close/comment on the issue rather than redoing the work. Treat issue checklists as
hints, not truth — committed code is done.
```

(If `ghprompt-workflow.md` has no obvious task-selection section, place it immediately after its first heading. Inspect the file first.)

- [ ] **Step 4: Verify**

Run: `pnpm --filter @phamvuhoang/otto-core test && pnpm -r typecheck`
Then a render smoke (confirm `{{ RESUME }}` resolves and doesn't leak):

```bash
pnpm -r build >/dev/null
node --input-type=module -e "
import { renderTemplate } from './packages/core/dist/render.js';
import { join } from 'node:path';
const t = join('packages/core/templates/afk.md');
const out = renderTemplate(t, { INPUTS: 'plan prd', RESUME: 'RESUMED-NOTE' }, { cwd: process.cwd(), spillHostDir: '/tmp/x', spillRefPath: '.otto-tmp/x' });
console.log('RESUME present:', out.includes('RESUMED-NOTE'));
console.log('no leaked tag:', !out.includes('{{ RESUME }}'));
const out2 = renderTemplate(t, { INPUTS: 'plan prd', RESUME: '' }, { cwd: process.cwd(), spillHostDir: '/tmp/x', spillRefPath: '.otto-tmp/x' });
console.log('empty resume, no leaked tag:', !out2.includes('{{ RESUME }}'));
"
```

Expected: all three lines `true`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/templates/afk.md packages/core/templates/ghafk.md packages/core/templates/prompt.md packages/core/templates/ghprompt-workflow.md
git commit -m "feat(core): RESUME prompt slot + reconcile-before-selecting playbook"
```

---

## Task 7: CLI flags + run-bin wiring (`--max-wait`, `--fresh`, `mode`)

**Files:**

- Modify: `packages/core/src/cli-help.ts`, `packages/core/src/run-bin.ts`, `packages/core/src/main.ts`, `packages/core/src/gh-main.ts`
- Modify: `packages/core/src/__tests__/cli-help.test.ts`

- [ ] **Step 1: Add a duration parser + flag tests.** Append to `cli-help.test.ts`:

```ts
import { parseDurationMs } from "../cli-help.js";

describe("parseDurationMs", () => {
  it("parses bare seconds", () => expect(parseDurationMs("90")).toBe(90_000));
  it("parses m/h/s suffixes", () => {
    expect(parseDurationMs("90m")).toBe(90 * 60_000);
    expect(parseDurationMs("6h")).toBe(6 * 3600_000);
    expect(parseDurationMs("45s")).toBe(45_000);
  });
  it("throws on garbage", () => expect(() => parseDurationMs("abc")).toThrow());
});

describe("parseFlags --max-wait / --fresh", () => {
  it("parses --max-wait and --fresh", () => {
    const f = parseFlags(["--max-wait", "2h", "--fresh", "5"]);
    expect(f.maxWaitMs).toBe(2 * 3600_000);
    expect(f.fresh).toBe(true);
    expect(f.rest).toEqual(["5"]);
  });
  it("errors when --max-wait has no value", () => {
    expect(() => parseFlags(["--max-wait"])).toThrow(
      /--max-wait requires a value/
    );
  });
  it("errors on an invalid --max-wait value", () => {
    expect(() => parseFlags(["--max-wait", "nope"])).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help.test`
Expected: FAIL.

- [ ] **Step 3: Implement `parseDurationMs` in `cli-help.ts`** (export it):

```ts
/** Parse a duration: bare integer = seconds; suffix s/m/h supported. Throws on invalid. */
export function parseDurationMs(raw: string): number {
  const m = raw.trim().match(/^(\d+)(s|m|h)?$/);
  if (!m) {
    throw new Error(
      `--max-wait must be seconds or a duration like 90m / 6h, got: ${JSON.stringify(raw)}`
    );
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "s";
  const factor = unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000;
  return n * factor;
}
```

- [ ] **Step 4: Add the flags to `CliFlags` + `parseFlags`** following the existing `--cooldown` pattern:

`CliFlags` gains:

```ts
  maxWaitMs?: number;
  fresh: boolean;
```

In `parseFlags`: add `let maxWaitMs: number | undefined; let expectingMaxWait = false; let fresh = false;`. Consume-value block:

```ts
if (expectingMaxWait) {
  maxWaitMs = parseDurationMs(a);
  expectingMaxWait = false;
  continue;
}
```

Flag-name chain: `else if (a === "--max-wait") expectingMaxWait = true;` and `else if (a === "--fresh") fresh = true;`. Post-loop guard: `if (expectingMaxWait) { throw new Error("--max-wait requires a value"); }`. Add `maxWaitMs, fresh,` to the returned object (initialize `fresh: false` in the return is via the `fresh` local).

- [ ] **Step 5: Help + print-config.** In `printHelp` Flags block add:

```
  --max-wait <dur>    cap the wait when rate-limited before halting (e.g. 90m, 6h; default 6h)
  --fresh             ignore any saved resume state and start from iteration 1
```

In `printHelp` Environment block add:

```
  OTTO_MAX_WAIT        default rate-limit wait cap (seconds or 90m/6h; default 6h).
```

In `PrintConfigOptions` add `maxWaitMs?: number;` and in `printConfig` add a line after `cooldown`:

```ts
  max-wait              ${maxWaitMs != null ? `${Math.round(maxWaitMs / 60000)}m` : "6h (default)"}
```

- [ ] **Step 6: `RunBinConfig.mode` + wiring in `run-bin.ts`.** Add `mode: string;` to `RunBinConfig`. Resolve maxWait from flag/env:

```ts
const envMaxWait = process.env.OTTO_MAX_WAIT?.trim();
const maxWaitMs =
  flags.maxWaitMs ?? (envMaxWait ? parseDurationMs(envMaxWait) : undefined);
```

Pass into the `printConfig(..., { ... })` call: `maxWaitMs`. Pass into the `runLoop({ ... })` call: `mode: cfg.mode, maxWaitMs, fresh: flags.fresh`. (Leave the `runWatch` call as-is for now; watch is a daemon — resilience there is a follow-up. If `runWatch` forwards to `runLoop`, it already inherits the loop behavior; do not add flags to `runWatch`'s signature in this task.)

- [ ] **Step 7: Set `mode` in the bins.** `main.ts` `runBin(argv, { ... mode: "afk", ... })`; `gh-main.ts` `runBin(argv, { ... mode: "ghafk", ... })`.

- [ ] **Step 8: Gitignore `.otto/state.json`.** First check: `ls packages/core/src/git.ts 2>/dev/null`.
  - If `git.ts`/`ensureTmpIgnored` exist (branch-strategy merged): extend the helper so it also ensures a `.otto/state.json` line (same text-scan idempotency as `.otto-tmp/`).
  - If they do NOT exist: in `run-bin.ts`, before the loop, append `.otto/state.json` to the workspace `.gitignore` if absent (small inline helper: read `.gitignore`, skip if a `.otto/state.json` line is present, else append). Use `node:fs` + a guard that no-ops outside a git repo (`existsSync(join(workspaceDir, ".git"))` is a sufficient cheap check here). Note this in the commit body for later reconciliation with the branch-strategy helper.

- [ ] **Step 9: Verify + smoke**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test
SMOKE=$(mktemp -d) && (cd "$SMOKE" && git init -q && git commit -q --allow-empty -m init)
OTTO_WORKSPACE=$SMOKE node apps/cli/bin/otto-afk.js --print-config "plan.md prd.md" 1
#   expect a "max-wait  6h (default)" line; with --max-wait 2h expect "120m"
OTTO_WORKSPACE=$SMOKE node apps/cli/bin/otto-afk.js --max-wait 2h --print-config "plan.md prd.md" 1
```

Expected: build/typecheck/tests green; print-config shows the max-wait line.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/run-bin.ts packages/core/src/main.ts packages/core/src/gh-main.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(core): --max-wait / --fresh flags + mode wiring + state.json gitignore"
```

---

## Task 8: Documentation

**Files:**

- Modify: `README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: README** — add `--max-wait`, `--fresh` to the flags table; `OTTO_MAX_WAIT` to the env table; a short "Resilience & resume" subsection: on a session/rate limit Otto waits until reset (capped by `--max-wait`, default 6h) then resumes the same iteration; a re-run of the same command auto-resumes from `.otto/state.json` (continuing to the original iteration total) and the implementer reconciles against git so committed work is never redone; `--fresh` forces a clean restart; `state.json` is gitignored.

- [ ] **Step 2: ARCHITECTURE.md** — note `rate-limit.ts` (limit detection + `RateLimitError`) and `state.ts` (advisory `.otto/state.json`), and that `loop.ts` waits out rate limits and resumes from saved state; mention the reconcile-before-selecting playbook rule.

- [ ] **Step 3: Verify + commit**

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: document rate-limit wait + resume behavior"
```

---

## Self-Review Notes (resolved)

- **Spec coverage:** A1 → Tasks 1,2; A2 → Task 3; A3 → Tasks 1(computeWaitMs),5,7(flags); B1 → Task 6; B2 → Tasks 4,5,7; B3 → Tasks 5,6; docs → Task 8. `mode` field → Tasks 4,5,7.
- **Type consistency:** `RateLimitError`/`isLimitResult`/`resetsAtFromEvent`/`computeWaitMs` (Task 1) used identically in Tasks 2,3,5. `RunState`/`readState`/`writeState`/`clearState`/`matchesResume` (Task 4) used in Task 5. `parseDurationMs` (Task 7) used in run-bin. `RESUME` var set in loop (Task 5) and consumed by templates (Task 6); `GENERIC_TAG` leaves unknown vars literal, so `RESUME` is always passed.
- **No circular import:** `rate-limit.ts` imports `StageResult` as `import type` only.
- **Base-branch caveat:** Task 7 Step 8 handles the case where the branch-strategy gitignore helper isn't present on `main`.
- **Watch mode:** explicitly left as-is this round (daemon resilience is follow-up); the loop-level behavior still applies to each `runLoop` the daemon spawns.
