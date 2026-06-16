import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  notifyComplete: vi.fn(),
  notifyError: vi.fn(),
  release: vi.fn(),
  runStage: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("../keepalive.js", () => ({
  acquire: mocks.acquire,
}));

vi.mock("../notify.js", () => ({
  notifyComplete: mocks.notifyComplete,
  notifyError: mocks.notifyError,
}));

vi.mock("../runner.js", () => ({
  runStage: mocks.runStage,
  stageLogPath: (workspaceDir: string, iteration: number, stageName: string) =>
    join(
      workspaceDir,
      ".otto-tmp",
      "logs",
      `iter${iteration}-${stageName}.ndjson`
    ),
}));

vi.mock("../pacing.js", () => ({
  sleep: mocks.sleep,
  isThrottle: (s: string | null) =>
    s != null && /429|overload|rate.?limit/i.test(s),
  nextCooldownFactor: (prev: number, throttled: boolean, cap = 8) =>
    throttled ? Math.min(prev * 2, cap) : 1,
}));

vi.mock("../stream-render.js", () => ({
  USE_COLOR: false,
  dim: (s: string) => s,
  bold: (s: string) => s,
  red: (s: string) => s,
  greenOut: (s: string) => s,
  boldOut: (s: string) => s,
  dimOut: (s: string) => s,
  SYM: { cross: "FAIL" },
  SYM_OUT: { bullet: "*" },
}));

import { runLoop, nextActionFor, countDeferredFollowups } from "../loop.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const sentinel = "<promise>NO MORE TASKS</promise>";

// Helper to build a StageResult-shaped object.
const ok = (
  result: string,
  costUsd = 0,
  apiErrorStatus: string | null = null
) => ({
  result,
  costUsd,
  isError: apiErrorStatus != null,
  apiErrorStatus,
});

type LoopDirs = {
  root: string;
  packageDir: string;
  workspaceDir: string;
};

function makeDirs(): LoopDirs {
  const root = mkdtempSync(join(tmpdir(), "otto-loop-"));
  const packageDir = join(root, "sandcastle");
  const workspaceDir = join(root, "workspace");

  mkdirSync(join(packageDir, "templates"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(packageDir, "templates", stage.template),
    "run {{ INPUTS }}",
    "utf8"
  );

  return { root, packageDir, workspaceDir };
}

function stdoutText(): string {
  return (process.stdout.write as unknown as { mock: { calls: unknown[][] } })
    .mock.calls.map((c) => String(c[0]))
    .join("");
}

function loopOptions(dirs: LoopDirs, overrides = {}) {
  return {
    stages: [stage] as [Stage],
    inputs: "plan",
    iterations: 1,
    workspaceDir: dirs.workspaceDir,
    packageDir: dirs.packageDir,
    ...overrides,
  };
}

describe("runLoop", () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.acquire.mockReturnValue({ release: mocks.release });
    mocks.sleep.mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("acquires the wake-lock and releases on completion", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { notify: true }));

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.notifyComplete).toHaveBeenCalledWith(1, true);
  });

  it("prints the cli + core version banner at loop init", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "otto-afk", cliVersion: "9.9.9" }));

    const stderr = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderr).toContain("otto-afk 9.9.9 (core ");
  });

  it("uses the bin name in the wake-lock reason", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "otto-ghafk" }));

    expect(mocks.acquire).toHaveBeenCalledWith({ reason: "otto-ghafk loop" });
  });

  it("logs terminal stage failure and continues with the next iteration", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok(sentinel));

    await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".otto-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain(
      "[failure] iteration 1 stage implementer failed after 0 retries: boom"
    );
  });

  it("retries a failed stage before continuing", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce(ok(sentinel));

    const loop = runLoop(loopOptions(dirs, { maxRetries: 1 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await loop;

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    const firstLog = readFileSync(
      join(dirs.workspaceDir, ".otto-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(firstLog).toContain("[retry] attempt 1 of 1 after 5000 ms");
  });

  it("retries a failing render and surfaces it as a terminal failure (no false completion)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Template whose shell tag always fails — emulates a flaky `gh issue list`.
    // Such a failure must abort/retry the stage, never silently degrade the
    // prompt into a false `<promise>NO MORE TASKS</promise>` completion.
    const failStage: Stage = { name: "implementer", template: "fail.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "fail.md"),
      "!`exit 1`",
      "utf8"
    );

    await runLoop(
      loopOptions(dirs, { stages: [failStage] as [Stage], maxRetries: 0 })
    );

    // Render threw before the stage ran: runStage never invoked, loop did not
    // reject, and the terminal failure was logged.
    expect(mocks.runStage).not.toHaveBeenCalled();
    const log = readFileSync(
      join(dirs.workspaceDir, ".otto-tmp", "logs", "iter1-implementer.ndjson"),
      "utf8"
    );
    expect(log).toContain("[failure] iteration 1 stage implementer failed");
  });

  it("aborts the active stage and releases the wake-lock on SIGINT", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGINT")).toThrow("exit 130");

    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("aborts the active stage and releases the wake-lock on SIGTERM", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let capturedSignal: AbortSignal | undefined;
    mocks.runStage.mockImplementation(
      (_stage, _prompt, _workspace, _iteration, _spill, _log, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    expect(() => process.emit("SIGTERM")).toThrow("exit 143");
    expect(capturedSignal?.aborted).toBe(true);
    await loop;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("sweeps ephemeral scratch but keeps logs on SIGINT", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const tmp = join(dirs.workspaceDir, ".otto-tmp");
    mkdirSync(join(tmp, "logs"), { recursive: true });
    writeFileSync(join(tmp, ".run-1-1-1.md"), "prompt", "utf8");
    writeFileSync(join(tmp, ".sandbox-1-1-1.json"), "{}", "utf8");
    mkdirSync(join(tmp, "spill-1-1-impl-1"));
    writeFileSync(join(tmp, "logs", "iter1.ndjson"), "{}", "utf8");
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.runStage.mockImplementation((_s, _p, _w, _i, _sp, _l, options) => {
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    });

    const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(() => process.emit("SIGINT")).toThrow("exit 130");
    await loop;

    expect(existsSync(join(tmp, ".run-1-1-1.md"))).toBe(false);
    expect(existsSync(join(tmp, ".sandbox-1-1-1.json"))).toBe(false);
    expect(existsSync(join(tmp, "spill-1-1-impl-1"))).toBe(false);
    expect(existsSync(join(tmp, "logs", "iter1.ndjson"))).toBe(true);
  });

  it("stops cleanly once cumulative cost reaches the budget", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "stage.md" };
    // Each implementer stage costs $0.60; reviewer $0; never emits the sentinel.
    mocks.runStage.mockImplementation((s) =>
      Promise.resolve(
        ok(
          s.name === "implementer" ? "keep going" : "ok",
          s.name === "implementer" ? 0.6 : 0
        )
      )
    );
    await runLoop(
      loopOptions(dirs, {
        stages: [stage, reviewer] as [Stage, Stage],
        iterations: 5,
        budgetUsd: 1.0,
        maxRetries: 0,
      })
    );
    // iter1: impl(0.6)+rev(0) = 0.6 < 1.0 → iter2 impl pushes to 1.2; budget halts before iter2 reviewer or iter3.
    // implementer ran twice, reviewer ran once.
    const implCalls = mocks.runStage.mock.calls.filter(
      (c) => c[0].name === "implementer"
    ).length;
    expect(implCalls).toBe(2);
  });

  it("returns a LoopOutcome with accumulated cost and sentinel flag", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
    const outcome = await runLoop(loopOptions(dirs));
    expect(outcome).toMatchObject({ sentinelHit: true });
    expect(outcome.costUsd).toBeCloseTo(0.25);
  });

  describe("end-of-run summary", () => {
    it("reports complete + iterations + cost on sentinel exit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
      await runLoop(loopOptions(dirs));
      expect(stdoutText()).toContain("Otto complete · 1 iteration · $0.25");
    });

    it("reports a budget exit with the iterations run and cost", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const reviewer: Stage = { name: "reviewer", template: "stage.md" };
      mocks.runStage.mockImplementation((s) =>
        Promise.resolve(ok(s.name === "implementer" ? "go" : "ok", 0.6))
      );
      await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          iterations: 5,
          budgetUsd: 1.0,
          maxRetries: 0,
        })
      );
      expect(stdoutText()).toContain("Otto stopped (budget) · 1 iteration · $1.20");
    });

    it("reports a plain done summary when iterations exhaust without the sentinel", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("keep going", 0.1)); // never sentinel
      await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));
      expect(stdoutText()).toContain("Otto done · 2 iterations · $0.20");
    });

    it("flags failures in the done summary when a stage failed", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockRejectedValue(new Error("boom"));
      await runLoop(loopOptions(dirs, { iterations: 1, maxRetries: 0 }));
      expect(stdoutText()).toContain("Otto done with failures · 1 iteration · $0.00");
    });

    it("reports an aborted summary when the active stage is aborted mid-run", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockImplementation((_s, _p, _w, _i, _sp, _l, options) => {
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      });
      const ac = new AbortController();
      const loop = runLoop(loopOptions(dirs, { signal: ac.signal, maxRetries: 0 }));
      await Promise.resolve();
      await Promise.resolve();
      ac.abort();
      await loop;
      expect(stdoutText()).toContain("Otto aborted · 0 iterations");
    });

    it("reports an aborted summary (not an error) when aborted during the cooldown", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("keep going")); // never sentinel
      const ac = new AbortController();
      // The cooldown sleep is the only sleep in this run; simulate an external
      // shutdown arriving while parked in it.
      mocks.sleep.mockImplementation(
        (_ms: number, signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("sleep aborted"))
            );
            ac.abort();
          })
      );
      await runLoop(
        loopOptions(dirs, {
          signal: ac.signal,
          iterations: 2,
          cooldownMs: 3000,
          maxRetries: 0,
        })
      );
      expect(stdoutText()).toContain("Otto aborted · 1 iteration");
    });

    it("reports a rate-limit halt summary when the reset is beyond maxWaitMs", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { RateLimitError } = await import("../rate-limit.js");
      const far = Math.floor(Date.now() / 1000) + 10 * 3600;
      mocks.runStage.mockRejectedValue(
        new RateLimitError("session limit", far)
      );
      await runLoop(
        loopOptions(dirs, { bin: "otto-afk", maxWaitMs: 6 * 3600_000 })
      );
      expect(stdoutText()).toContain("Otto halted (rate limit)");
    });

    it("appends a next-action hint to the summary", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
      await runLoop(loopOptions(dirs));
      expect(stdoutText()).toContain("→ next: review the diff, then open a PR");
    });

    it("tailors the next-action hint to the exit reason", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const reviewer: Stage = { name: "reviewer", template: "stage.md" };
      mocks.runStage.mockImplementation((s) =>
        Promise.resolve(ok(s.name === "implementer" ? "go" : "ok", 0.6))
      );
      await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          iterations: 5,
          budgetUsd: 1.0,
          maxRetries: 0,
        })
      );
      expect(stdoutText()).toContain("→ next: raise `--budget` and re-run to resume");
    });

    it("points failures at the stage logs", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockRejectedValue(new Error("boom"));
      await runLoop(loopOptions(dirs, { iterations: 1, maxRetries: 0 }));
      expect(stdoutText()).toContain(
        "→ next: inspect the failed stage logs under `.otto-tmp/logs`, then re-run"
      );
    });

    it("surfaces the deferred-work count when review-followups.md has entries", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mkdirSync(join(dirs.workspaceDir, ".otto"), { recursive: true });
      writeFileSync(
        join(dirs.workspaceDir, ".otto", "review-followups.md"),
        "## 2026-06-16 review\n\n- perf: re-reads N days every pull (low) — deferred\n- ops: backfill at deploy (med) — deferred\n",
        "utf8"
      );
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
      await runLoop(loopOptions(dirs));
      expect(stdoutText()).toContain(
        "2 deferred follow-ups in .otto/review-followups.md"
      );
    });

    it("omits the deferred-work line when no follow-ups are recorded", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
      await runLoop(loopOptions(dirs));
      expect(stdoutText()).not.toContain("deferred follow-up");
    });
  });

  describe("countDeferredFollowups", () => {
    it("counts one top-level bullet per deferred finding", () => {
      expect(
        countDeferredFollowups(
          "## 2026-06-16 review\n\n- a (low) — deferred\n- b (med) — deferred\n"
        )
      ).toBe(2);
    });

    it("ignores headings, prose, blanks, and the lazy placeholder", () => {
      expect(countDeferredFollowups("_No follow-ups recorded yet._")).toBe(0);
      expect(countDeferredFollowups("")).toBe(0);
      expect(
        countDeferredFollowups("## heading only\n\nprose, no bullets\n")
      ).toBe(0);
    });

    it("counts only top-level bullets, not nested detail", () => {
      expect(
        countDeferredFollowups("- finding one\n  - sub detail\n- finding two\n")
      ).toBe(2);
    });

    it("excludes bullets marked FIXED/RESOLVED on a continuation line", () => {
      expect(
        countDeferredFollowups(
          "- #1 still open (med) — deferred\n" +
            "- #2 abort mislabel (low)\n  (medium-low) — FIXED: routed through summarize\n" +
            "- #3 done (low) — RESOLVED in a later commit\n" +
            "- #4 still open (low) — deferred\n"
        )
      ).toBe(2);
    });

    it("ignores bullets quoted inside a fenced code block", () => {
      expect(
        countDeferredFollowups(
          "- #1 still open (low) — deferred\n" +
            "  example diff:\n" +
            "```diff\n" +
            "- removed line\n" +
            "- another removed line\n" +
            "```\n" +
            "- #2 still open (low) — deferred\n"
        )
      ).toBe(2);
    });
  });

  describe("nextActionFor", () => {
    it("maps each known exit reason to an imperative hint", () => {
      expect(nextActionFor("complete")).toBe("review the diff, then open a PR");
      expect(nextActionFor("done")).toBe("review the diff, then open a PR");
      expect(nextActionFor("done with failures")).toBe(
        "inspect the failed stage logs under `.otto-tmp/logs`, then re-run"
      );
      expect(nextActionFor("stopped (budget)")).toBe(
        "raise `--budget` and re-run to resume"
      );
      expect(nextActionFor("halted (rate limit)")).toBe(
        "re-run after the limit resets to resume"
      );
      expect(nextActionFor("aborted")).toBe(
        "re-run to resume from the saved iteration"
      );
      expect(nextActionFor("stopped (error)")).toBe(
        "inspect the error above, then re-run"
      );
    });

    it("falls back to a generic hint for an unknown reason", () => {
      expect(nextActionFor("something new")).toBe("re-run to resume");
    });
  });

  it("uses an injected signal and installs no process signal handlers", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));
    const before = process.listenerCount("SIGINT");
    const ac = new AbortController();
    await runLoop(loopOptions(dirs, { signal: ac.signal }));
    expect(process.listenerCount("SIGINT")).toBe(before); // none added/left behind
  });

  it("sleeps between iterations when a cooldown is set", async () => {
    vi.useFakeTimers();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok("keep going")); // never sentinel
    // Override the sleep mock to actually resolve after fake timer advances.
    mocks.sleep.mockImplementation(
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    );
    const loop = runLoop(
      loopOptions(dirs, { iterations: 2, cooldownMs: 3000, maxRetries: 0 })
    );
    // Let iter1 run to completion (runStage mock resolves immediately).
    await vi.advanceTimersByTimeAsync(0);
    // After iter1, the loop should be parked in sleep(3000).
    // Advance past the cooldown to let iter2 run.
    await vi.advanceTimersByTimeAsync(3000);
    await loop;
    expect(mocks.runStage).toHaveBeenCalledTimes(2);
  });

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
    expect(mocks.runStage).toHaveBeenCalledTimes(2);
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
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
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
    mocks.runStage.mockResolvedValue(ok("still working"));

    await runLoop(
      loopOptions(dirs, { mode: "afk", bin: "otto-afk", iterations: 5 })
    );

    expect(mocks.runStage).toHaveBeenCalledTimes(3); // resumed 3→5
  });

  it("clears state on sentinel completion", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));
    await runLoop(loopOptions(dirs, { mode: "afk", bin: "otto-afk" }));
    const { readState } = await import("../state.js");
    expect(readState(dirs.workspaceDir)).toBeNull();
  });
});
