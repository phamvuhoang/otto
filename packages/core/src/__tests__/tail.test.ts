import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runTail, type TailDeps } from "../tail.js";
import {
  writeManifest,
  writeStageRecord,
  type RunManifest,
  type StageRecord,
} from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-tail-"));
}

/** Create a no-sleep deps with a call-by-call manifest sequence. */
function makeDeps(
  cwd: string,
  manifests: RunManifest[],
  maxPolls = 5
): { deps: TailDeps; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  let callCount = 0;
  const deps: TailDeps = {
    env: { OTTO_WORKSPACE: cwd } as NodeJS.ProcessEnv,
    cwd,
    out: (m: string) => out.push(m),
    err: (m: string) => errs.push(m),
    sleep: () => Promise.resolve(),
    maxPolls,
    readManifest: (_ws: string, _id: string) => {
      const m = manifests[Math.min(callCount++, manifests.length - 1)];
      return m ?? null;
    },
  };
  return { deps, out, errs };
}

const runId = "2026-06-20T00-00-00-000Z-99";

const inProgress: RunManifest = {
  runId,
  bin: "otto-afk",
  mode: "afk",
  inputs: "build a thing",
  runtime: { id: "claude", displayName: "Claude Code" },
  iterations: 3,
  completedIterations: 0,
  costUsd: 0.05,
  tokenUsage: { ...emptyTokenUsage(), inputTokens: 200, outputTokens: 80 },
  artifacts: [],
  startedAt: "2026-06-20T00:00:00.000Z",
};

const finished: RunManifest = {
  ...inProgress,
  completedIterations: 2,
  costUsd: 0.42,
  exitReason: "done",
  nextAction: "review the diff",
  finishedAt: "2026-06-20T00:05:00.000Z",
};

const implStage: StageRecord = {
  iteration: 1,
  stage: "implementer",
  runtimeId: "claude",
  costUsd: 0.2,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-06-20T00:00:00.000Z",
  finishedAt: "2026-06-20T00:01:00.000Z",
};

describe("runTail — latest resolution", () => {
  it("resolves 'latest' to the most recent run and exits 0", async () => {
    const ws = tmp();
    const olderRunId = "2026-06-20T00-00-00-000Z-1";
    const newerRunId = "2026-06-20T09-00-00-000Z-2";
    writeManifest(ws, { ...finished, runId: olderRunId });
    writeManifest(ws, { ...finished, runId: newerRunId });
    writeStageRecord(ws, newerRunId, 0, implStage);

    const out: string[] = [];
    const errs: string[] = [];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: (m) => out.push(m),
      err: (m) => errs.push(m),
      sleep: () => Promise.resolve(),
      maxPolls: 5,
    };

    // Resolves to the newer run → exits 0 (finalized)
    const code = await runTail(["latest"], deps);
    expect(code).toBe(0);
    // Done card should appear
    expect(out.join("\n")).toMatch(/Otto done/);
  });

  it("resolves no arg to the latest run", async () => {
    const ws = tmp();
    writeManifest(ws, finished);
    writeStageRecord(ws, runId, 0, implStage);

    const out: string[] = [];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: (m) => out.push(m),
      err: () => {},
      sleep: () => Promise.resolve(),
      maxPolls: 5,
    };

    const code = await runTail([], deps);
    expect(code).toBe(0);
  });
});

describe("runTail — finalized manifest renders done card", () => {
  it("prints the done card and exits 0 when manifest is already finalized", async () => {
    const ws = tmp();
    writeManifest(ws, finished);
    writeStageRecord(ws, runId, 0, implStage);

    const { deps, out } = makeDeps(ws, [finished]);
    const code = await runTail([runId], deps);

    expect(code).toBe(0);
    const joined = out.join("\n");
    // done card first line: Otto done · N iteration(s) · $cost
    expect(joined).toMatch(/Otto done/);
    expect(joined).toMatch(/iteration/);
  });
});

describe("runTail — in-progress manifest renders live tree", () => {
  it("prints a live tree frame while running, then done card once finalized", async () => {
    const ws = tmp();
    writeManifest(ws, inProgress);
    writeStageRecord(ws, runId, 0, implStage);

    // Call sequence: initial check → inProgress; poll 1 → inProgress (live tree); poll 2 → finished (done card)
    const { deps, out } = makeDeps(ws, [inProgress, inProgress, finished], 5);
    const code = await runTail([runId], deps);

    expect(code).toBe(0);
    const joined = out.join("\n");
    // Live tree frame should mention the bin + running status
    expect(joined).toMatch(/otto-afk/);
    // Done card should appear at end
    expect(joined).toMatch(/Otto done/);
  });

  it("emits at least one live tree frame before the done card", async () => {
    const ws = tmp();
    writeManifest(ws, inProgress);
    writeStageRecord(ws, runId, 0, implStage);

    const frames: string[] = [];
    let callCount = 0;
    const manifests = [inProgress, inProgress, finished];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: (m) => frames.push(m),
      err: () => {},
      sleep: () => Promise.resolve(),
      maxPolls: 10,
      readManifest: (_ws: string, _id: string) => {
        return manifests[Math.min(callCount++, manifests.length - 1)];
      },
    };

    const code = await runTail([runId], deps);
    expect(code).toBe(0);
    // Multiple frames: at least one live + one done card
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // Last frame is the done card
    expect(frames[frames.length - 1]).toMatch(/Otto done/);
  });
});

describe("runTail — error cases", () => {
  it("exits 1 when the run-id is unknown", async () => {
    const ws = tmp();
    writeManifest(ws, finished);

    const errs: string[] = [];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: () => {},
      err: (m) => errs.push(m),
      sleep: () => Promise.resolve(),
      maxPolls: 5,
    };

    const code = await runTail(["does-not-exist"], deps);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does-not-exist/);
  });

  it("exits 1 when there are no runs at all", async () => {
    const ws = tmp();

    const errs: string[] = [];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: () => {},
      err: (m) => errs.push(m),
      sleep: () => Promise.resolve(),
      maxPolls: 5,
    };

    const code = await runTail([], deps);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no runs/i);
  });

  it("shows help with -h and exits 0", async () => {
    const out: string[] = [];
    const deps: TailDeps = {
      env: {} as NodeJS.ProcessEnv,
      cwd: tmp(),
      out: (m) => out.push(m),
      err: () => {},
      sleep: () => Promise.resolve(),
      maxPolls: 5,
    };

    const code = await runTail(["-h"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/otto-tail/);
  });
});

describe("runTail — deterministic polling via injected deps", () => {
  it("stops after maxPolls without finalizing — returns non-zero", async () => {
    const ws = tmp();
    writeManifest(ws, inProgress);

    // Always returns in-progress — never finalizes
    const out: string[] = [];
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: (m) => out.push(m),
      err: () => {},
      sleep: () => Promise.resolve(),
      maxPolls: 3,
    };

    const code = await runTail([runId], deps);
    // Not 0 since it timed out without finalizing
    expect(code).not.toBe(0);
    // Did print live tree frames
    expect(out.length).toBeGreaterThan(0);
  });

  it("sleep is never called with a real delay — injected sleep is always used", async () => {
    const ws = tmp();
    writeManifest(ws, finished);

    let sleepCalls = 0;
    const deps: TailDeps = {
      env: { OTTO_WORKSPACE: ws } as NodeJS.ProcessEnv,
      cwd: ws,
      out: () => {},
      err: () => {},
      sleep: (ms: number) => {
        sleepCalls++;
        // If a real sleep was called here the test would timeout
        expect(ms).toBeGreaterThan(0);
        return Promise.resolve();
      },
      maxPolls: 5,
    };

    const code = await runTail([runId], deps);
    expect(code).toBe(0);
    // Already finalized — no polls needed, sleep may be 0 or 1 calls
    expect(sleepCalls).toBeLessThanOrEqual(1);
  });
});
