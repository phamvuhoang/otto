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
import { emptyTokenUsage, type TokenUsage } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  notifyComplete: vi.fn(),
  notifyError: vi.fn(),
  release: vi.fn(),
  runPanel: vi.fn(),
  runStage: vi.fn(),
  getAgentRuntime: vi.fn((id: string) => ({ id })),
  sleep: vi.fn(),
  discoverPlanTasks: vi.fn(),
  runFanout: vi.fn(),
  reapWorktrees: vi.fn(),
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
  getAgentRuntime: mocks.getAgentRuntime,
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

vi.mock("../panel.js", () => ({
  runPanel: mocks.runPanel,
}));

vi.mock("../fanout.js", () => ({
  runFanout: mocks.runFanout,
}));

vi.mock("../plan-tasks.js", async (importActual) => ({
  ...(await importActual<typeof import("../plan-tasks.js")>()),
  discoverPlanTasks: mocks.discoverPlanTasks,
}));

vi.mock("../worktree.js", async (importActual) => ({
  ...(await importActual<typeof import("../worktree.js")>()),
  reapWorktrees: mocks.reapWorktrees,
}));

vi.mock("../stream-render.js", () => ({
  USE_COLOR: false,
  dim: (s: string) => s,
  bold: (s: string) => s,
  red: (s: string) => s,
  greenOut: (s: string) => s,
  boldOut: (s: string) => s,
  dimOut: (s: string) => s,
  SYM: {
    bullet: "*",
    cont: "  >",
    check: "ok",
    cross: "FAIL",
    rule: "=",
    ellip: "...",
  },
  SYM_OUT: { bullet: "*" },
}));

import { runLoop, nextActionFor, countDeferredFollowups } from "../loop.js";
import { listRunIds, readManifest, readStageRecords } from "../run-report.js";
import { recordStaticValidation, writeSkill } from "../skills.js";
import { skillChecksum } from "../skill-validation.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const sentinel = "<promise>NO MORE TASKS</promise>";

// Helper to build a StageResult-shaped object.
const ok = (
  result: string,
  costUsd = 0,
  apiErrorStatus: string | null = null,
  usage: TokenUsage = emptyTokenUsage()
) => ({
  result,
  costUsd,
  isError: apiErrorStatus != null,
  apiErrorStatus,
  usage,
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
  // The P15 emit-time report-rubric gate may invoke this stage directly when an
  // emitted report fails the legibility rubric; its template must resolve.
  writeFileSync(
    join(packageDir, "templates", "report-rewrite.md"),
    "rewrite {{ MISSING }}",
    "utf8"
  );

  return { root, packageDir, workspaceDir };
}

function stdoutText(): string {
  return (
    process.stdout.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

function stderrText(): string {
  return (
    process.stderr.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

function withFakeTty(): {
  setRawMode: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const descriptors = {
    stdinIsTty: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    stdoutIsTty: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    stderrIsTty: Object.getOwnPropertyDescriptor(process.stderr, "isTTY"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
    resume: Object.getOwnPropertyDescriptor(process.stdin, "resume"),
    pause: Object.getOwnPropertyDescriptor(process.stdin, "pause"),
  };
  const setRawMode = vi.fn();
  const resume = vi.fn();
  const pause = vi.fn();
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: setRawMode,
  });
  Object.defineProperty(process.stdin, "resume", {
    configurable: true,
    value: resume,
  });
  Object.defineProperty(process.stdin, "pause", {
    configurable: true,
    value: pause,
  });
  const restore = () => {
    for (const [target, key, descriptor] of [
      [process.stdin, "isTTY", descriptors.stdinIsTty],
      [process.stdout, "isTTY", descriptors.stdoutIsTty],
      [process.stderr, "isTTY", descriptors.stderrIsTty],
      [process.stdin, "setRawMode", descriptors.setRawMode],
      [process.stdin, "resume", descriptors.resume],
      [process.stdin, "pause", descriptors.pause],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as unknown as Record<string, unknown>)[key];
    }
  };
  return { setRawMode, resume, pause, restore };
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
    mocks.getAgentRuntime.mockImplementation((id: string) => ({ id }));
    mocks.sleep.mockResolvedValue(undefined);
    // Fan-out off by default: no tasks discovered, so the fan-out block no-ops
    // for every test that does not opt into `fanOut`.
    mocks.discoverPlanTasks.mockReturnValue([]);
    mocks.runFanout.mockResolvedValue({ outcomes: [], deferred: [] });
    mocks.reapWorktrees.mockReturnValue(undefined);
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

  it("plan + fan-out that lands work reviews the aggregated diff instead of re-planning (#177)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    // Distinct templates so we can tell which stage actually ran from the prompt.
    const planStage: Stage = { name: "plan", template: "plan.md" };
    const reviewStage: Stage = { name: "reviewer", template: "reviewer.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "plan.md"),
      "PLAN_STAGE {{ INPUTS }}",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "reviewer.md"),
      "REVIEW_STAGE {{ INPUTS }}",
      "utf8"
    );
    // Fan-out discovers a task and lands it.
    mocks.discoverPlanTasks.mockReturnValue([{ id: "t1" }]);
    mocks.runFanout.mockResolvedValue({
      outcomes: [{ status: "landed" }],
      deferred: [],
    });
    mocks.runStage.mockResolvedValue(ok("reviewed, fixes committed"));

    const outcome = await runLoop(
      loopOptions(dirs, {
        stages: [planStage],
        reviewStage,
        mode: "plan",
        fanOut: true,
        iterations: 1,
      })
    );

    // Exactly one stage ran, and it was the reviewer — not the plan re-author.
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    const prompt = String(mocks.runStage.mock.calls[0][1]);
    expect(prompt).toContain("REVIEW_STAGE");
    expect(prompt).not.toContain("PLAN_STAGE");
    // The run finalizes as a complete implementation run.
    expect(outcome.sentinelHit).toBe(false);
    const manifest = readManifest(
      dirs.workspaceDir,
      listRunIds(dirs.workspaceDir)[0]
    );
    expect(manifest?.exitReason).toBe("complete");
  });

  it("plan + fan-out that lands nothing still authors a plan (no reviewer substitution) (#177)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const planStage: Stage = { name: "plan", template: "plan.md" };
    const reviewStage: Stage = { name: "reviewer", template: "reviewer.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "plan.md"),
      "PLAN_STAGE {{ INPUTS }}",
      "utf8"
    );
    writeFileSync(
      join(dirs.packageDir, "templates", "reviewer.md"),
      "REVIEW_STAGE {{ INPUTS }}",
      "utf8"
    );
    // No tasks to fan out — a genuine plan-authoring run.
    mocks.discoverPlanTasks.mockReturnValue([]);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        stages: [planStage],
        reviewStage,
        mode: "plan",
        fanOut: true,
        iterations: 1,
      })
    );

    // The plan stage ran (the reviewer was not substituted).
    expect(mocks.runStage).toHaveBeenCalledTimes(1);
    expect(String(mocks.runStage.mock.calls[0][1])).toContain("PLAN_STAGE");
  });

  it("injects input-sharpening guidance into the plan prompt for a thin input when --sharpen-input is on (#180)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const planStage: Stage = { name: "plan", template: "plan.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "plan.md"),
      "<inputs>\n{{ INPUTS }}\n</inputs>\n{{ SHARPENING }}\n# PLAN",
      "utf8"
    );
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        stages: [planStage],
        mode: "plan",
        sharpenInput: true,
        inputs: "make the dashboard faster",
        iterations: 1,
      })
    );

    const prompt = String(mocks.runStage.mock.calls[0][1]);
    expect(prompt).toContain("Input sharpening");
    expect(prompt).toContain("## Decisions");

    // The sharpness assessment is recorded on the manifest as evidence (#180 s3).
    const manifest = readManifest(
      dirs.workspaceDir,
      listRunIds(dirs.workspaceDir)[0]
    );
    expect(manifest?.inputSharpness?.maxScore).toBe(5);
    expect(manifest?.inputSharpness?.unknowns.length).toBeGreaterThan(0);
  });

  it("leaves the plan prompt unchanged when --sharpen-input is off (default, inert) (#180)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const planStage: Stage = { name: "plan", template: "plan.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "plan.md"),
      "<inputs>\n{{ INPUTS }}\n</inputs>\n{{ SHARPENING }}\n# PLAN",
      "utf8"
    );
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        stages: [planStage],
        mode: "plan",
        inputs: "make the dashboard faster",
        iterations: 1,
      })
    );

    const prompt = String(mocks.runStage.mock.calls[0][1]);
    expect(prompt).not.toContain("Input sharpening");
    // The {{ SHARPENING }} var resolves to empty, never leaking as a literal tag.
    expect(prompt).not.toContain("{{ SHARPENING }}");

    // Sharpening off ⇒ no sharpness block on the manifest (#180 s3).
    const manifest = readManifest(
      dirs.workspaceDir,
      listRunIds(dirs.workspaceDir)[0]
    );
    expect(manifest?.inputSharpness).toBeUndefined();
  });

  it("injects a validated skill + records skillsUsed when activation is on (P18)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const body = "Write the failing test first.";
    writeSkill(
      dirs.workspaceDir,
      recordStaticValidation(
        {
          name: "tdd",
          version: "1.0.0",
          capabilities: ["tdd"],
          constraints: [],
          scope: [],
          instructions: body,
          scripts: {},
          tests: [],
          validation: {},
          trust: "unverified",
          createdAt: new Date(0).toISOString(),
          useCount: 0,
        },
        { compatibility: "afk-safe", stages: [], checksum: skillChecksum(body) }
      )
    );
    mocks.runStage.mockResolvedValue(ok("did work, no sentinel"));

    await runLoop(
      loopOptions(dirs, {
        iterations: 1,
        skillActivation: { enabled: true, stages: {} },
      })
    );

    const prompt = String(mocks.runStage.mock.calls[0][1]);
    expect(prompt).toContain("<available-skills");
    expect(prompt).toContain(body);

    const runId = listRunIds(dirs.workspaceDir)[0];
    const records = readStageRecords(dirs.workspaceDir, runId);
    expect(records[0].skillsUsed?.[0]).toMatchObject({
      name: "tdd",
      stage: "implementer",
    });
    expect(readManifest(dirs.workspaceDir, runId)?.skillsUsed?.[0]?.name).toBe(
      "tdd"
    );
  });

  it("does not inject or record skills when activation is off (default)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const body = "Write the failing test first.";
    writeSkill(
      dirs.workspaceDir,
      recordStaticValidation(
        {
          name: "tdd",
          version: "1.0.0",
          capabilities: ["tdd"],
          constraints: [],
          scope: [],
          instructions: body,
          scripts: {},
          tests: [],
          validation: {},
          trust: "unverified",
          createdAt: new Date(0).toISOString(),
          useCount: 0,
        },
        { compatibility: "afk-safe", stages: [], checksum: skillChecksum(body) }
      )
    );
    mocks.runStage.mockResolvedValue(ok("did work, no sentinel"));

    await runLoop(loopOptions(dirs, { iterations: 1 }));

    expect(String(mocks.runStage.mock.calls[0][1])).not.toContain(
      "available-skills"
    );
    const runId = listRunIds(dirs.workspaceDir)[0];
    expect(readManifest(dirs.workspaceDir, runId)?.skillsUsed).toBeUndefined();
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

  it("shows the active runtime in the version banner, stage banner, and summary", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        bin: "otto-afk",
        cliVersion: "9.9.9",
        agentId: "codex",
        agentDisplayName: "Codex CLI",
      })
    );

    const stderr = stderrText();
    // run banner
    expect(stderr).toContain("otto-afk 9.9.9 (core ");
    expect(stderr).toContain("runtime: Codex CLI");
    // stage banner names the runtime
    expect(stderr).toMatch(/iteration 1\/1 · implementer .*Codex CLI/);
    // summary line names the runtime id
    expect(stdoutText()).toContain("runtime: codex");
  });

  it("defaults the runtime to Claude when not provided", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(loopOptions(dirs, { bin: "otto-afk", cliVersion: "9.9.9" }));

    expect(stderrText()).toContain("runtime: Claude Code");
    expect(stdoutText()).toContain("runtime: claude");
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

  it("installs TTY keyboard controls and prints the hint", async () => {
    const tty = withFakeTty();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    try {
      await runLoop(loopOptions(dirs));
    } finally {
      tty.restore();
    }

    expect(tty.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(tty.resume).toHaveBeenCalled();
    expect(stderrText()).toContain(
      "controls: [p] pause after current stage · [r] resume · [q] quit (save state & exit)"
    );
    expect(tty.setRawMode).toHaveBeenLastCalledWith(false);
    expect(tty.pause).toHaveBeenCalledTimes(1);
  });

  it("does not install keyboard controls for non-TTY runs", async () => {
    const tty = withFakeTty();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    try {
      await runLoop(loopOptions(dirs));
    } finally {
      tty.restore();
    }

    expect(tty.setRawMode).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain("controls: [p]");
  });

  it("does not install keyboard controls when output is not a TTY", async () => {
    const tty = withFakeTty();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    try {
      await runLoop(loopOptions(dirs));
    } finally {
      tty.restore();
    }

    expect(tty.setRawMode).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain("controls: [p]");
  });

  it("does not install keyboard controls when stderr is not a TTY", async () => {
    const tty = withFakeTty();
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: false,
    });
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    try {
      await runLoop(loopOptions(dirs));
    } finally {
      tty.restore();
    }

    expect(tty.setRawMode).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain("controls: [p]");
  });

  it("does not install keyboard controls for externally signaled runs", async () => {
    const tty = withFakeTty();
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));
    const ac = new AbortController();

    try {
      await runLoop(loopOptions(dirs, { signal: ac.signal }));
    } finally {
      tty.restore();
    }

    expect(tty.setRawMode).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain("controls: [p]");
  });

  it("pauses after the current stage and resumes in the same process", async () => {
    const tty = withFakeTty();
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "stage.md" };
    let finishImplementer!: () => void;
    mocks.runStage.mockImplementation((s) => {
      if (s.name === "implementer") {
        return new Promise((resolve) => {
          finishImplementer = () => resolve(ok("keep going"));
        });
      }
      return Promise.resolve(ok(sentinel));
    });

    try {
      const loop = runLoop(
        loopOptions(dirs, { stages: [stage, reviewer] as [Stage, Stage] })
      );
      await Promise.resolve();
      process.stdin.emit("data", Buffer.from("p"));
      finishImplementer();

      await vi.waitFor(() => {
        expect(mocks.runStage).toHaveBeenCalledTimes(1);
        expect(stderrText()).toContain("paused — press r to resume");
      });

      process.stdin.emit("data", Buffer.from("r"));
      await loop;
    } finally {
      tty.restore();
    }

    expect(mocks.runStage).toHaveBeenCalledTimes(2);
    expect(stderrText()).toContain("resuming");
  });

  it("quits cleanly from keyboard controls and restores the terminal", async () => {
    const tty = withFakeTty();
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

    try {
      const loop = runLoop(loopOptions(dirs, { maxRetries: 0 }));
      await vi.waitFor(() => {
        expect(capturedSignal?.aborted).toBe(false);
      });

      expect(() => process.stdin.emit("data", Buffer.from("q"))).toThrow(
        "exit 130"
      );
      expect(capturedSignal?.aborted).toBe(true);
      await loop;
    } finally {
      tty.restore();
    }

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
    expect(tty.setRawMode).toHaveBeenLastCalledWith(false);
    expect(tty.pause).toHaveBeenCalledTimes(1);
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

  it("escalates the model tier after repeated gate-stage failures (#66 P11)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const implStage: Stage = {
      name: "implementer",
      template: "stage.md",
      tier: "mid",
    };
    const reviewer: Stage = { name: "reviewer", template: "stage.md" };
    // Implementer errors every iteration (never the sentinel) → the gate-failure
    // streak grows and the routed tier climbs from mid (sonnet) to strong (opus).
    mocks.runStage.mockImplementation((s) =>
      Promise.resolve(
        s.name === "implementer"
          ? ok("keep going", 0, "boom") // apiErrorStatus set → isError true
          : ok("ok")
      )
    );
    await runLoop(
      loopOptions(dirs, {
        stages: [implStage, reviewer] as [Stage, Stage],
        iterations: 3,
        maxRetries: 0,
        modelRouting: true,
        tierLadder: { cheap: "haiku", mid: "sonnet", strong: "opus" },
      })
    );
    const implModels = mocks.runStage.mock.calls
      .filter((c) => c[0].name === "implementer")
      .map((c) => c[6]?.modelSpec);
    expect(implModels).toHaveLength(3);
    expect(implModels[0]).toBe("sonnet"); // no escalation yet
    expect(implModels[2]).toBe("opus"); // two prior failures → strong
  });

  it("with --fan-out but no tasks.json, runs the normal sequential loop (#66 P11)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));
    await runLoop(loopOptions(dirs, { fanOut: true, fanOutConcurrency: 3 }));
    // No .otto/tasks/<key>/tasks.json exists → fan-out is a no-op and the gate
    // implementer stage still runs (graceful degradation invariant).
    const implCalls = mocks.runStage.mock.calls.filter(
      (c) => c[0].name === "implementer"
    ).length;
    expect(implCalls).toBe(1);
    expect(stdoutText() + "").toBeDefined();
  });

  it("returns a LoopOutcome with accumulated cost and sentinel flag", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
    const outcome = await runLoop(loopOptions(dirs));
    expect(outcome).toMatchObject({ sentinelHit: true });
    expect(outcome.costUsd).toBeCloseTo(0.25);
  });

  it("the journal hook is a no-op without a journal config (#67 P12)", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));
    await runLoop(loopOptions(dirs));
    // No .otto/config.json journal block ⇒ the run-end hook does nothing:
    // no .otto/journal dir, no extra stages beyond the gate implementer.
    expect(existsSync(join(dirs.workspaceDir, ".otto", "journal"))).toBe(false);
  });

  describe("end-of-run summary", () => {
    it("reports complete + iterations + cost on sentinel exit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));
      await runLoop(loopOptions(dirs));
      expect(stdoutText()).toContain("Otto complete · 1 iteration · $0.25");
    });

    it("reports token usage in measure mode", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(
        ok(sentinel, 0.25, null, {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        })
      );
      await runLoop(loopOptions(dirs, { tokenMode: "measure" }));
      expect(stderrText()).toContain(
        "tokens in 10 | out 2 | cache create 3 | cache read 4 | total 19"
      );
      expect(stdoutText()).toContain(
        "tokens in 10 | out 2 | cache create 3 | cache read 4 | total 19"
      );
    });

    it("does not report token usage in off mode", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(
        ok(sentinel, 0.25, null, {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        })
      );
      await runLoop(loopOptions(dirs, { tokenMode: "off" }));
      expect(stderrText()).not.toContain("tokens in");
      expect(stdoutText()).not.toContain("tokens in");
    });

    it("rolls back panel sub-stage accounting when a panel attempt is retried after a rate limit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const reviewer: Stage = { name: "reviewer", template: "stage.md" };
      const { RateLimitError } = await import("../rate-limit.js");
      mocks.runStage.mockResolvedValue(ok("keep going"));
      mocks.runPanel
        .mockImplementationOnce(
          (opts: { onStage: (sr: ReturnType<typeof ok>) => void }) => {
            opts.onStage(
              ok("failed-attempt-lens", 0.5, null, {
                inputTokens: 10,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              })
            );
            throw new RateLimitError(
              "session limit",
              Math.floor(Date.now() / 1000)
            );
          }
        )
        .mockImplementationOnce(
          (opts: { onStage: (sr: ReturnType<typeof ok>) => void }) => {
            const sr = ok("successful-panel", 0.4, null, {
              inputTokens: 7,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            });
            opts.onStage(sr);
            return sr;
          }
        );

      const outcome = await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          reviewLenses: ["correctness"],
          tokenMode: "measure",
          maxRetries: 0,
        })
      );

      expect(mocks.runPanel).toHaveBeenCalledTimes(2);
      expect(outcome.costUsd).toBeCloseTo(0.4);
      expect(outcome.tokenUsage).toMatchObject({
        inputTokens: 7,
        outputTokens: 1,
      });
      expect(stdoutText()).toContain(
        "tokens in 7 | out 1 | cache create 0 | cache read 0 | total 8"
      );
      expect(stdoutText()).not.toContain("total 18");
      // The discarded attempt's already-printed per-stage lines reconcile via
      // an explicit rollback note on stderr.
      expect(stderrText()).toContain(
        "discarding rate-limited attempt's partial accounting (−$0.50)"
      );
    });

    it("rolls back panel sub-stage records when a panel attempt is retried after a rate limit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const reviewer: Stage = { name: "reviewer", template: "stage.md" };
      const { RateLimitError } = await import("../rate-limit.js");
      mocks.runStage.mockResolvedValue(ok("keep going"));
      type PanelOpts = {
        recordStage: (n: string, sr: ReturnType<typeof ok>, t: string) => void;
      };
      mocks.runPanel
        .mockImplementationOnce((opts: PanelOpts) => {
          // First attempt records a lens substage, then a later substage limits.
          opts.recordStage(
            "correctness",
            ok("lens"),
            "2026-01-01T00:00:00.000Z"
          );
          throw new RateLimitError(
            "session limit",
            Math.floor(Date.now() / 1000)
          );
        })
        .mockImplementationOnce((opts: PanelOpts) => {
          const sr = ok("<review>OK</review>");
          opts.recordStage(
            "correctness",
            ok("lens"),
            "2026-01-01T00:00:01.000Z"
          );
          opts.recordStage("review-synth", sr, "2026-01-01T00:00:02.000Z");
          return sr;
        });

      await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          reviewLenses: ["correctness"],
          maxRetries: 0,
        })
      );

      expect(mocks.runPanel).toHaveBeenCalledTimes(2);
      const { runsDir, readStageRecords } = await import("../run-report.js");
      const ids = (await import("node:fs")).readdirSync(
        runsDir(dirs.workspaceDir)
      );
      const records = readStageRecords(dirs.workspaceDir, ids[0]);
      // The failed attempt's lens record is rolled back: just the gate plus the
      // successful attempt's two substages, no duplicate `correctness` record.
      expect(records.map((r) => r.stage)).toEqual([
        "implementer",
        "correctness",
        "review-synth",
      ]);
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
      expect(stdoutText()).toContain(
        "Otto stopped (budget) · 1 iteration · $1.20"
      );
    });

    it("reports a plain done summary when iterations exhaust without the sentinel", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("keep going", 0.1)); // never sentinel
      await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));
      expect(stdoutText()).toContain("Otto done · 2 iterations · $0.20");
    });

    it("persists an emitted quality report into the bundle and links it (P9 #64)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const report =
        "# Otto quality report\n\n## Verdict\n\nNeeds human review\n";
      // The gate stage emits the report AND the completion sentinel (the real
      // ghafk implementer does both on the finishing iteration).
      mocks.runStage.mockResolvedValue(ok(`${report}\n${sentinel}`));
      await runLoop(loopOptions(dirs, { maxRetries: 0 }));

      const { runsDir, readManifest, readRunReport } =
        await import("../run-report.js");
      const ids = (await import("node:fs")).readdirSync(
        runsDir(dirs.workspaceDir)
      );
      expect(readRunReport(dirs.workspaceDir, ids[0])).toContain(
        "# Otto quality report"
      );
      const manifest = readManifest(dirs.workspaceDir, ids[0]);
      expect(manifest?.artifacts.some((a) => a.kind === "report")).toBe(true);
    });

    it("persists a harness fallback report when no stage emits one (P15 #85)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel)); // gate completes, no marker
      await runLoop(loopOptions(dirs, { maxRetries: 0 }));

      const { runsDir, readManifest, readRunReport } =
        await import("../run-report.js");
      const ids = (await import("node:fs")).readdirSync(
        runsDir(dirs.workspaceDir)
      );
      const report = readRunReport(dirs.workspaceDir, ids[0]);
      expect(report).toContain("# Otto quality report");
      expect(report).toContain("## What You Can Now Do");
      expect(report).toContain("## Automated Evidence");
      const manifest = readManifest(dirs.workspaceDir, ids[0]);
      expect(manifest?.artifacts.some((a) => a.kind === "report")).toBe(true);
    });

    it("runs the report-rewrite stage once when the emitted report fails the rubric (P15)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      // Gate emits a report that is MISSING the layperson sections (fails the
      // rubric) plus the sentinel. The rewrite stage emits a complete report.
      const badReport = "# Otto quality report\n\n## Verdict\n\nAccepted\n";
      const goodReport = [
        "# Otto quality report",
        "## Verdict",
        "Accepted",
        "## What You Can Now Do",
        "Ship it.",
        "## Why",
        "Because.",
        "## How To Verify",
        "1. Run it.",
        "## What To Watch",
        "Nothing.",
        "## What I Was Unsure About",
        "Nothing.",
        "_Engineer detail below — a non-engineer can stop reading here._",
      ].join("\n\n");
      mocks.runStage.mockImplementation((s) => {
        if (s.name === "report-rewrite") return Promise.resolve(ok(goodReport));
        return Promise.resolve(ok(`${badReport}\n${sentinel}`));
      });
      await runLoop(loopOptions(dirs, { maxRetries: 0 }));

      const rewriteCalls = mocks.runStage.mock.calls.filter(
        (c) => (c[0] as Stage).name === "report-rewrite"
      );
      expect(rewriteCalls).toHaveLength(1);

      const { runsDir, readRunReport } = await import("../run-report.js");
      const ids = (await import("node:fs")).readdirSync(
        runsDir(dirs.workspaceDir)
      );
      const report = readRunReport(dirs.workspaceDir, ids[0]);
      // The persisted report reflects the rewrite stage's complete output.
      expect(report).toContain("## What You Can Now Do");
      expect(report).toContain("Ship it.");
    });

    it("does not run the report-rewrite stage when the emitted report passes the rubric (P15)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const goodReport = [
        "# Otto quality report",
        "## Verdict",
        "Accepted",
        "## What You Can Now Do",
        "Ship it.",
        "## Why",
        "Because.",
        "## How To Verify",
        "1. Run it.",
        "## What To Watch",
        "Nothing.",
        "## What I Was Unsure About",
        "Nothing.",
        "_Engineer detail below — a non-engineer can stop reading here._",
      ].join("\n\n");
      mocks.runStage.mockResolvedValue(ok(`${goodReport}\n${sentinel}`));
      await runLoop(loopOptions(dirs, { maxRetries: 0 }));

      const rewriteCalls = mocks.runStage.mock.calls.filter(
        (c) => (c[0] as Stage).name === "report-rewrite"
      );
      expect(rewriteCalls).toHaveLength(0);
    });

    it("flags failures in the done summary when a stage failed", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockRejectedValue(new Error("boom"));
      await runLoop(loopOptions(dirs, { iterations: 1, maxRetries: 0 }));
      expect(stdoutText()).toContain(
        "Otto done with failures · 1 iteration · $0.00"
      );
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
      const loop = runLoop(
        loopOptions(dirs, { signal: ac.signal, maxRetries: 0 })
      );
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
      expect(stdoutText()).toContain(
        "→ next: raise `--budget` and re-run to resume"
      );
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

  describe("auto-switch on limit", () => {
    const runtimeOf = (call: number) =>
      (mocks.runStage.mock.calls[call][6] as { runtime: { id: string } })
        .runtime.id;

    it("switches to the fallback runtime on a rate limit instead of waiting", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      writeFileSync(
        join(dirs.packageDir, "templates", stage.template),
        "{{ RESUME }}\nrun {{ INPUTS }}",
        "utf8"
      );
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future))
        .mockResolvedValueOnce(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          agentDisplayName: "Claude Code",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: true,
        })
      );

      expect(mocks.runStage).toHaveBeenCalledTimes(2);
      expect(runtimeOf(0)).toBe("claude");
      expect(runtimeOf(1)).toBe("codex"); // retried on the fallback
      expect(mocks.sleep).not.toHaveBeenCalled(); // switched, did not wait
      expect(stderrText()).toContain("auto-switch");
      expect(stdoutText()).toContain("runtime: claude -> codex");
      expect(String(mocks.runStage.mock.calls[1][1])).toContain(
        "Auto-switched from Claude Code to Codex CLI after a rate limit"
      );
      expect(String(mocks.runStage.mock.calls[1][1])).toContain(
        "Reconcile against git history and the working tree"
      );
    });

    it("passes the auto-switch reconciliation note into the review panel", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const reviewer: Stage = { name: "reviewer", template: "stage.md" };
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future))
        .mockResolvedValueOnce(ok("keep going"));
      mocks.runPanel.mockResolvedValue(ok("<review>OK</review>"));

      await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          agentDisplayName: "Claude Code",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: true,
          reviewLenses: ["correctness"],
        })
      );

      expect(mocks.runPanel).toHaveBeenCalledTimes(1);
      expect(mocks.runPanel.mock.calls[0][0].resumeNote).toContain(
        "Auto-switched from Claude Code to Codex CLI after a rate limit"
      );
    });

    it("waits instead of switching when the fallback adapter is unavailable", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.getAgentRuntime.mockImplementation((id: string) => {
        if (id === "codex") throw new Error("codex unavailable");
        return { id };
      });
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future))
        .mockResolvedValueOnce(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          agentDisplayName: "Claude Code",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: true,
        })
      );

      expect(mocks.sleep).toHaveBeenCalled();
      expect(runtimeOf(1)).toBe("claude");
      expect(stderrText()).toContain("auto-switch skipped");
      expect(stdoutText()).toContain("runtime: claude");
      expect(stdoutText()).not.toContain("runtime: claude -> codex");
    });

    it("switches codex -> claude (reverse direction)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future))
        .mockResolvedValueOnce(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "codex",
          agentDisplayName: "Codex CLI",
          fallbackAgentId: "claude",
          fallbackAgentDisplayName: "Claude Code",
          autoSwitchOnLimit: true,
        })
      );

      expect(runtimeOf(1)).toBe("claude");
      expect(stdoutText()).toContain("runtime: codex -> claude");
    });

    it("waits instead of switching when auto-switch is off", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future))
        .mockResolvedValueOnce(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: false,
        })
      );

      expect(mocks.sleep).toHaveBeenCalled();
      expect(runtimeOf(1)).toBe("claude"); // stayed on the primary
      expect(stderrText()).not.toContain("auto-switch");
    });

    it("waits for reset when the fallback runtime also hits a limit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { RateLimitError } = await import("../rate-limit.js");
      const future = Math.floor(Date.now() / 1000) + 600;
      mocks.runStage
        .mockRejectedValueOnce(new RateLimitError("session limit", future)) // claude → switch
        .mockRejectedValueOnce(new RateLimitError("session limit", future)) // codex also limits
        .mockResolvedValueOnce(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: true,
        })
      );

      expect(mocks.runStage).toHaveBeenCalledTimes(3);
      expect(mocks.sleep).toHaveBeenCalled(); // waited after the fallback limit
      expect(runtimeOf(2)).toBe("codex"); // did not switch back
      const switchCount = stderrText().split("auto-switch").length - 1;
      expect(switchCount).toBe(1); // only one switch announced
    });

    it("resumes onto the persisted fallback runtime", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      const { writeState } = await import("../state.js");
      writeState(dirs.workspaceDir, {
        bin: "otto-afk",
        mode: "afk",
        inputs: "plan",
        iteration: 1,
        of: 1,
        status: "running",
        agent: "codex",
        startedAt: "x",
        updatedAt: "x",
      });
      mocks.runStage.mockResolvedValue(ok(sentinel));

      await runLoop(
        loopOptions(dirs, {
          bin: "otto-afk",
          mode: "afk",
          agentId: "claude",
          agentDisplayName: "Claude Code",
          fallbackAgentId: "codex",
          fallbackAgentDisplayName: "Codex CLI",
          autoSwitchOnLimit: true,
        })
      );

      expect(runtimeOf(0)).toBe("codex"); // resumed on the fallback
      expect(stderrText().split("\n")[0]).toContain("runtime: Codex CLI");
      expect(stdoutText()).toContain("runtime: claude -> codex");
    });
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

  it("writes an initial run manifest at loop start", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, {
        mode: "ghafk",
        bin: "otto-ghafk",
        inputs: "39",
        iterations: 4,
        branchStrategy: "branch",
      })
    );

    const { runsDir, readManifest } = await import("../run-report.js");
    const ids = (await import("node:fs")).readdirSync(
      runsDir(dirs.workspaceDir)
    );
    expect(ids).toHaveLength(1);
    const manifest = readManifest(dirs.workspaceDir, ids[0]);
    expect(manifest).toMatchObject({
      runId: ids[0],
      bin: "otto-ghafk",
      mode: "ghafk",
      inputs: "39",
      runtime: { id: "claude", displayName: "Claude Code" },
      branchStrategy: "branch",
      iterations: 4,
    });
    expect(manifest?.startedAt).toBeTruthy();
  });

  it("writes one stage record per executed stage", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "review.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "review.md"),
      "review {{ INPUTS }}",
      "utf8"
    );
    // never the sentinel, so both stages run in the single iteration.
    mocks.runStage.mockResolvedValue(ok("keep going", 0.1));

    await runLoop(
      loopOptions(dirs, { stages: [stage, reviewer], iterations: 1 })
    );

    const { runsDir, readStageRecords } = await import("../run-report.js");
    const ids = (await import("node:fs")).readdirSync(
      runsDir(dirs.workspaceDir)
    );
    expect(ids).toHaveLength(1);
    const records = readStageRecords(dirs.workspaceDir, ids[0]);
    expect(records.map((r) => r.stage)).toEqual(["implementer", "reviewer"]);
    expect(records[0]).toMatchObject({
      iteration: 1,
      stage: "implementer",
      costUsd: 0.1,
      isError: false,
      runtimeId: "claude",
    });
    expect(records[0].startedAt).toBeTruthy();
    expect(records[0].finishedAt).toBeTruthy();
  });

  it("records the gate stage even when it hits the sentinel", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "review.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "review.md"),
      "review {{ INPUTS }}",
      "utf8"
    );
    mocks.runStage.mockResolvedValue(ok(sentinel));

    await runLoop(
      loopOptions(dirs, { stages: [stage, reviewer], iterations: 1 })
    );

    const { runsDir, readStageRecords } = await import("../run-report.js");
    const ids = (await import("node:fs")).readdirSync(
      runsDir(dirs.workspaceDir)
    );
    const records = readStageRecords(dirs.workspaceDir, ids[0]);
    // gate hit the sentinel, so the reviewer never ran: just the gate record.
    expect(records.map((r) => r.stage)).toEqual(["implementer"]);
  });

  it("hands the panel a recordStage callback and does not double-record the panel stage", async () => {
    const dirs = makeDirs();
    roots.push(dirs.root);
    const reviewer: Stage = { name: "reviewer", template: "review.md" };
    writeFileSync(
      join(dirs.packageDir, "templates", "review.md"),
      "review",
      "utf8"
    );
    mocks.runStage.mockResolvedValue(ok("keep going", 0.1));
    mocks.runPanel.mockResolvedValue(ok("<review>OK</review>", 0.2));

    await runLoop(
      loopOptions(dirs, {
        stages: [stage, reviewer],
        iterations: 1,
        reviewLenses: ["correctness"],
      })
    );

    expect(mocks.runPanel).toHaveBeenCalledTimes(1);
    expect(typeof mocks.runPanel.mock.calls[0][0].recordStage).toBe("function");

    const { runsDir, readStageRecords } = await import("../run-report.js");
    const ids = (await import("node:fs")).readdirSync(
      runsDir(dirs.workspaceDir)
    );
    const records = readStageRecords(dirs.workspaceDir, ids[0]);
    // the (mocked) panel records its own substages; the loop records only the
    // non-panel gate stage, never an umbrella record for the panel reviewer.
    expect(records.map((r) => r.stage)).toEqual(["implementer"]);
  });

  describe("finalizes the run manifest on terminal paths", () => {
    const readOnlyManifest = async (workspaceDir: string) => {
      const { runsDir, readManifest } = await import("../run-report.js");
      const ids = (await import("node:fs")).readdirSync(runsDir(workspaceDir));
      expect(ids).toHaveLength(1);
      return readManifest(workspaceDir, ids[0]);
    };

    it("finalizes on sentinel completion", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));

      await runLoop(loopOptions(dirs, { iterations: 3 }));

      const m = await readOnlyManifest(dirs.workspaceDir);
      expect(m).toMatchObject({
        exitReason: "complete",
        completedIterations: 1,
        costUsd: 0.25,
        nextAction: "review the diff, then open a PR",
      });
      expect(m?.finishedAt).toBeTruthy();
      // The raw NDJSON logs stay linked so raw debugging remains available.
      expect(m?.artifacts.some((a) => a.kind === "ndjson-logs")).toBe(true);
    });

    it("finalizes a plain done exit when iterations exhaust", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("keep going", 0.1)); // never sentinel

      await runLoop(loopOptions(dirs, { iterations: 2, maxRetries: 0 }));

      const m = await readOnlyManifest(dirs.workspaceDir);
      expect(m).toMatchObject({
        exitReason: "done",
        completedIterations: 2,
        costUsd: 0.2,
      });
    });

    it("finalizes a budget stop with the exit reason and next action", async () => {
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

      const m = await readOnlyManifest(dirs.workspaceDir);
      expect(m).toMatchObject({
        exitReason: "stopped (budget)",
        completedIterations: 1,
        costUsd: 1.2,
        nextAction: "raise `--budget` and re-run to resume",
      });
    });

    it("finalizes a done-with-failures exit", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockRejectedValue(new Error("boom"));

      await runLoop(loopOptions(dirs, { iterations: 1, maxRetries: 0 }));

      const m = await readOnlyManifest(dirs.workspaceDir);
      expect(m?.exitReason).toBe("done with failures");
      expect(m?.completedIterations).toBe(1);
    });

    it("links the review-followups trail as an artifact when present", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mkdirSync(join(dirs.workspaceDir, ".otto"), { recursive: true });
      writeFileSync(
        join(dirs.workspaceDir, ".otto", "review-followups.md"),
        "- a (low) — deferred\n",
        "utf8"
      );
      mocks.runStage.mockResolvedValue(ok(sentinel, 0.25));

      await runLoop(loopOptions(dirs));

      const m = await readOnlyManifest(dirs.workspaceDir);
      expect(m?.artifacts.map((a) => a.kind)).toContain("review-followups");
    });
  });

  describe("adaptive router", () => {
    const reviewer: Stage = { name: "reviewer", template: "stage.md" };
    const lensPool = ["correctness", "security", "tests"];

    function routerOptions(dirs: LoopDirs, changedPaths: string[]) {
      // Implementer (gate) does NOT emit the sentinel, so the reviewer runs.
      mocks.runStage.mockImplementation((s: Stage) =>
        Promise.resolve(
          s.name === "implementer" ? ok("did work") : ok("reviewed")
        )
      );
      mocks.runPanel.mockResolvedValue(ok("paneled"));
      return loopOptions(dirs, {
        stages: [stage, reviewer] as [Stage, Stage],
        reviewLenses: lensPool,
        adaptiveRouter: true,
        resolveChangedPaths: () => changedPaths,
      });
    }

    it("routes a medium-risk change to a lens subset panel", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      await runLoop(routerOptions(dirs, ["packages/core/src/eval.ts"]));

      expect(mocks.runPanel).toHaveBeenCalledTimes(1);
      expect(mocks.runPanel).toHaveBeenCalledWith(
        expect.objectContaining({ lenses: ["correctness", "tests"] })
      );
      expect(stderrText()).toContain("adaptive router: narrow-code");
    });

    it("routes a high-risk change to the full panel", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      await runLoop(
        routerOptions(dirs, ["packages/core/src/auth.ts", "apps/cli/x.js"])
      );
      expect(mocks.runPanel).toHaveBeenCalledWith(
        expect.objectContaining({ lenses: lensPool })
      );
    });

    it("routes a low-risk docs change to a single reviewer (no panel)", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      await runLoop(routerOptions(dirs, ["README.md"]));

      expect(mocks.runPanel).not.toHaveBeenCalled();
      // implementer + single reviewer both went through runStage.
      expect(mocks.runStage).toHaveBeenCalledTimes(2);
      expect(stderrText()).toContain(
        "adaptive router: docs-only → single reviewer"
      );
    });

    it("leaves the static review path untouched when the flag is off", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockImplementation((s: Stage) =>
        Promise.resolve(
          s.name === "implementer" ? ok("did work") : ok("reviewed")
        )
      );
      mocks.runPanel.mockResolvedValue(ok("paneled"));
      // No adaptiveRouter: a low-risk path must NOT downgrade the configured panel.
      await runLoop(
        loopOptions(dirs, {
          stages: [stage, reviewer] as [Stage, Stage],
          reviewLenses: lensPool,
          resolveChangedPaths: () => ["README.md"],
        })
      );
      expect(mocks.runPanel).toHaveBeenCalledWith(
        expect.objectContaining({ lenses: lensPool })
      );
      expect(stderrText()).not.toContain("adaptive router");
    });

    it("stops early after consecutive iterations produce no diff", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      // Implementer never emits the sentinel; the router sees no file change each
      // iteration, so it stops on low progress before exhausting all 3.
      mocks.runStage.mockResolvedValue(ok("still working"));
      await runLoop(
        loopOptions(dirs, {
          iterations: 3,
          adaptiveRouter: true,
          resolveChangedPaths: () => [],
        })
      );
      expect(mocks.runStage).toHaveBeenCalledTimes(2); // stopped after iteration 2
      expect(stderrText()).toContain("stop-low-progress"); // router decision marker
      expect(stdoutText()).toContain("stopped (low progress)"); // run summary line
    });

    it("does not early-stop when the flag is off", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("still working"));
      await runLoop(
        loopOptions(dirs, { iterations: 3, resolveChangedPaths: () => [] })
      );
      expect(mocks.runStage).toHaveBeenCalledTimes(3); // ran every iteration
      expect(stderrText()).not.toContain("stop-low-progress");
    });

    it("resets the stall counter when an iteration makes a change", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);
      mocks.runStage.mockResolvedValue(ok("still working"));
      // no-change, then a change, then no-change → never 2 stalls in a row.
      const seq = [[], ["a.ts"], []];
      let n = 0;
      await runLoop(
        loopOptions(dirs, {
          iterations: 3,
          adaptiveRouter: true,
          resolveChangedPaths: () => seq[n++] ?? [],
        })
      );
      expect(mocks.runStage).toHaveBeenCalledTimes(3); // ran every iteration
      expect(stderrText()).not.toContain("stop-low-progress");
    });
  });

  describe("plan mode gate (P13)", () => {
    // A deliberately thin plan: no rubric criteria and no depth criteria met.
    // scorePlanQuality → 0/8 (0% < 75% threshold) → gate FAILS.
    const thinPlan = "# A plan\n\nNo structure here.\n";

    // A rich plan that satisfies all rubric criteria and all depth criteria.
    // Each task must name a failing test + test file + verify command to pass
    // the depth criterion taskTestAndVerify.
    const richPlan = [
      "## Problem statement",
      "",
      "We need to fix the scoring logic. Assumptions: X, Y. Decisions: use vitest.",
      "",
      "## Scope guard",
      "",
      "Non-goals: we won't refactor the CLI.",
      "",
      "## Files",
      "",
      "- `packages/core/src/plan-rubric.ts`",
      "- `packages/core/src/__tests__/plan-rubric.test.ts`",
      "",
      "## Tasks",
      "",
      "1. Write failing test — test-first, pinned by `packages/core/src/__tests__/plan-rubric.test.ts`",
      "   verify: `pnpm vitest run`",
      "2. Implement the fix — write failing test pinned by `packages/core/src/__tests__/plan-rubric.test.ts`",
      "   verify: `pnpm vitest run`",
      "",
      "## Success criteria",
      "",
      "Done when all tests pass and `pnpm vitest run` exits 0. Acceptance: run command above.",
      "Testable success: assert score.ratio > 0.75.",
    ].join("\n");

    it("plan mode re-plans once on a thin plan, then pauses", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);

      // Write a thin plan so assessPlanGate returns passed: false.
      mkdirSync(join(dirs.workspaceDir, ".otto", "tasks", "task-1"), {
        recursive: true,
      });
      writeFileSync(
        join(dirs.workspaceDir, ".otto", "tasks", "task-1", "plan.md"),
        thinPlan,
        "utf8"
      );

      // Gate stage always emits the sentinel (plan "done") on every call.
      mocks.runStage.mockResolvedValue(ok(sentinel));

      await runLoop(loopOptions(dirs, { mode: "plan", iterations: 3 }));

      // The gate stage (index 0) must have run TWICE:
      // - first pass: gate fails → replan (s -= 1; continue → re-runs stage 0)
      // - second pass: gate fails again (replan already used) → pause
      expect(mocks.runStage).toHaveBeenCalledTimes(2);

      // The run must terminate with the paused-needs-human summary.
      expect(stdoutText()).toContain("paused (needs human)");

      // Stderr must mention the gate failure and the pause decision.
      const err = stderrText();
      expect(err).toContain("plan gate: FAIL");
      expect(err).toContain(
        "plan gate still failed after one re-plan — pausing for human review"
      );
    });

    it("plan mode passes the gate on the first try for a rich plan", async () => {
      const dirs = makeDirs();
      roots.push(dirs.root);

      mkdirSync(join(dirs.workspaceDir, ".otto", "tasks", "task-1"), {
        recursive: true,
      });
      writeFileSync(
        join(dirs.workspaceDir, ".otto", "tasks", "task-1", "plan.md"),
        richPlan,
        "utf8"
      );

      mocks.runStage.mockResolvedValue(ok(sentinel));

      await runLoop(loopOptions(dirs, { mode: "plan", iterations: 3 }));

      // Gate runs exactly ONCE — plan passes on the first check.
      expect(mocks.runStage).toHaveBeenCalledTimes(1);

      // Run completes normally (no pause).
      expect(stdoutText()).toContain("Otto complete");
      expect(stdoutText()).not.toContain("paused (needs human)");

      // Stderr shows the gate PASS.
      expect(stderrText()).toContain("plan gate: PASS");
    });
  });
});
