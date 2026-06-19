import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatRunReport, runInspect } from "../inspect.js";
import {
  writeManifest,
  writeStageRecord,
  type RunManifest,
  type StageRecord,
} from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-inspect-"));
}

const finalized: RunManifest = {
  runId: "2026-06-19T00-00-00-000Z-13793",
  bin: "otto-ghafk",
  mode: "ghafk",
  inputs: "39",
  runtime: { id: "claude", displayName: "Claude Code" },
  branchStrategy: "branch",
  iterations: 5,
  completedIterations: 2,
  costUsd: 1.23,
  tokenUsage: { ...emptyTokenUsage(), inputTokens: 100, outputTokens: 50 },
  exitReason: "complete",
  nextAction: "review the diff, then open a PR",
  artifacts: [
    { kind: "logs", path: ".otto-tmp/logs", description: "raw NDJSON logs" },
    { kind: "review-followups", path: ".otto/review-followups.md" },
  ],
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:05:00.000Z",
};

const implStage: StageRecord = {
  iteration: 1,
  stage: "implementer",
  runtimeId: "claude",
  costUsd: 0.42,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:01:00.000Z",
};

const reviewerStage: StageRecord = {
  ...implStage,
  stage: "reviewer",
  costUsd: 0.1,
  isError: true,
  apiErrorStatus: "429",
  finishedAt: "2026-06-19T00:02:00.000Z",
};

describe("formatRunReport", () => {
  it("answers what happened and why Otto stopped", () => {
    const out = formatRunReport(finalized, [implStage, reviewerStage]);
    // Identity + why it stopped.
    expect(out).toContain("2026-06-19T00-00-00-000Z-13793");
    expect(out).toContain("otto-ghafk");
    expect(out).toContain("ghafk");
    expect(out).toContain("Claude Code");
    expect(out).toContain("complete");
    expect(out).toContain("review the diff, then open a PR");
    // Spend + progress.
    expect(out).toContain("$1.23");
    expect(out).toContain("2 / 5");
    // Stages, with the errored one flagged.
    expect(out).toContain("implementer");
    expect(out).toContain("reviewer");
    expect(out).toContain("429");
    // Artifacts.
    expect(out).toContain(".otto-tmp/logs");
    expect(out).toContain(".otto/review-followups.md");
  });

  it("marks an un-finalized manifest instead of inventing an exit reason", () => {
    const initial: RunManifest = {
      ...finalized,
      completedIterations: undefined,
      exitReason: undefined,
      nextAction: undefined,
      finishedAt: undefined,
      costUsd: 0,
      artifacts: [],
    };
    const out = formatRunReport(initial, []);
    expect(out).toMatch(/not finalized|in progress/i);
    // No exit reason / next action invented for a run that never finalized.
    expect(out).not.toContain("exit:");
    expect(out).not.toContain("review the diff");
  });
});

describe("runInspect", () => {
  function deps(cwd: string) {
    const lines: string[] = [];
    const errs: string[] = [];
    return {
      d: {
        env: { OTTO_WORKSPACE: cwd } as NodeJS.ProcessEnv,
        cwd,
        out: (m: string) => lines.push(m),
        err: (m: string) => errs.push(m),
      },
      lines,
      errs,
    };
  }

  it("renders an explicit run-id and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeStageRecord(ws, finalized.runId, 0, implStage);
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("complete");
  });

  it("defaults to the latest run when given no arg or 'latest'", async () => {
    const ws = tmp();
    const older: RunManifest = {
      ...finalized,
      runId: "2026-06-19T00-00-00-000Z-1",
      exitReason: "aborted",
    };
    const newer: RunManifest = {
      ...finalized,
      runId: "2026-06-19T09-00-00-000Z-1",
      exitReason: "complete",
    };
    writeManifest(ws, older);
    writeManifest(ws, newer);

    const a = deps(ws);
    expect(await runInspect([], a.d)).toBe(0);
    expect(a.lines.join("\n")).toContain(newer.runId);

    const b = deps(ws);
    expect(await runInspect(["latest"], b.d)).toBe(0);
    expect(b.lines.join("\n")).toContain(newer.runId);
  });

  it("errors when the run-id is unknown", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    const { d, errs } = deps(ws);
    const code = await runInspect(["does-not-exist"], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does-not-exist/);
  });

  it("errors when there are no runs at all", async () => {
    const { d, errs } = deps(tmp());
    const code = await runInspect([], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no runs/i);
  });
});
