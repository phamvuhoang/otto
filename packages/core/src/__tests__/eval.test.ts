import { describe, expect, it } from "vitest";

import { compareTrajectories, scoreTrajectory, type EvalSignals } from "../eval.js";
import type { RunManifest, StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function signals(overrides: Partial<EvalSignals> = {}): EvalSignals {
  return {
    succeeded: true,
    exitReason: "complete",
    completedIterations: 1,
    stageCount: 2,
    errorStageCount: 0,
    costUsd: 0.5,
    totalTokens: 1000,
    elapsedMs: 10_000,
    safetyEventCount: 0,
    skillUsageCount: 0,
    planQualityRatio: null,
    reportLegibilityRatio: null,
    ...overrides,
  };
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "2026-06-19T00-00-00-000Z-1",
    bin: "otto-ghafk",
    mode: "ghafk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 3,
    completedIterations: 1,
    costUsd: 0,
    tokenUsage: emptyTokenUsage(),
    exitReason: "complete",
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:10.000Z",
    artifacts: [],
    ...overrides,
  };
}

function stage(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    iteration: 1,
    stage: "implementer",
    runtimeId: "claude",
    costUsd: 0,
    usage: emptyTokenUsage(),
    isError: false,
    apiErrorStatus: null,
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:05.000Z",
    ...overrides,
  };
}

describe("scoreTrajectory", () => {
  it("marks complete/done runs as succeeded", () => {
    expect(scoreTrajectory(manifest({ exitReason: "complete" }), []).succeeded).toBe(
      true
    );
    expect(scoreTrajectory(manifest({ exitReason: "done" }), []).succeeded).toBe(
      true
    );
  });

  it("does not mark non-success exit reasons as succeeded", () => {
    for (const exitReason of [
      "done with failures",
      "stopped (budget)",
      "halted (rate limit)",
      "aborted",
      "stopped (error)",
    ]) {
      expect(
        scoreTrajectory(manifest({ exitReason }), []).succeeded,
        exitReason
      ).toBe(false);
    }
  });

  it("treats an un-finalized run as not succeeded", () => {
    const m = manifest({ exitReason: undefined, finishedAt: undefined });
    const s = scoreTrajectory(m, []);
    expect(s.succeeded).toBe(false);
    expect(s.exitReason).toBeNull();
    expect(s.elapsedMs).toBeNull();
  });

  it("passes through exitReason and completedIterations", () => {
    const s = scoreTrajectory(
      manifest({ exitReason: "done", completedIterations: 2 }),
      []
    );
    expect(s.exitReason).toBe("done");
    expect(s.completedIterations).toBe(2);
  });

  it("counts stages and error stages", () => {
    const stages = [
      stage({ isError: false }),
      stage({ isError: true, apiErrorStatus: "529" }),
      stage({ isError: true, apiErrorStatus: null }),
    ];
    const s = scoreTrajectory(manifest(), stages);
    expect(s.stageCount).toBe(3);
    expect(s.errorStageCount).toBe(2);
  });

  it("yields zero counts for an empty stage list", () => {
    const s = scoreTrajectory(manifest(), []);
    expect(s.stageCount).toBe(0);
    expect(s.errorStageCount).toBe(0);
  });

  it("passes through cost and sums total tokens", () => {
    const s = scoreTrajectory(
      manifest({
        costUsd: 1.23,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 3,
        },
      }),
      []
    );
    expect(s.costUsd).toBe(1.23);
    expect(s.totalTokens).toBe(128);
  });

  it("computes elapsedMs from the manifest timestamps", () => {
    const s = scoreTrajectory(
      manifest({
        startedAt: "2026-06-19T00:00:00.000Z",
        finishedAt: "2026-06-19T00:00:10.000Z",
      }),
      []
    );
    expect(s.elapsedMs).toBe(10_000);
  });

  it("returns null elapsedMs when a timestamp is unparseable", () => {
    const s = scoreTrajectory(
      manifest({ startedAt: "not-a-date", finishedAt: "also-bad" }),
      []
    );
    expect(s.elapsedMs).toBeNull();
  });

  it("counts safety events across the manifest and stage records", () => {
    const taint = {
      category: "taint" as const,
      kind: "issue-body" as const,
      subject: "x",
      message: "m",
      blocked: false,
    };
    const s = scoreTrajectory(
      manifest({ safetyEvents: [taint] }),
      [stage({ safetyEvents: [taint, taint] }), stage()]
    );
    expect(s.safetyEventCount).toBe(3);
  });

  it("reports zero safety events when none are recorded", () => {
    expect(scoreTrajectory(manifest(), [stage()]).safetyEventCount).toBe(0);
  });

  it("counts skills used across the manifest and stage records", () => {
    const use = { name: "release-flow", version: "1.0.0" };
    const s = scoreTrajectory(
      manifest({ skillsUsed: [use] }),
      [stage({ skillsUsed: [use, use] }), stage()]
    );
    expect(s.skillUsageCount).toBe(3);
    expect(scoreTrajectory(manifest(), [stage()]).skillUsageCount).toBe(0);
  });

  it("captures the plan-quality ratio when a plan score is supplied (#63)", () => {
    const planScore = {
      results: [],
      metCount: 6,
      maxScore: 8,
      ratio: 0.75,
      missing: [],
    };
    expect(
      scoreTrajectory(manifest(), [stage()], { planScore }).planQualityRatio
    ).toBe(0.75);
  });

  it("leaves plan-quality null when no plan score is supplied", () => {
    expect(scoreTrajectory(manifest(), [stage()]).planQualityRatio).toBeNull();
  });

  it("captures the report-legibility ratio when a report score is supplied (#64)", () => {
    const reportScore = {
      results: [],
      metCount: 5,
      maxScore: 7,
      ratio: 5 / 7,
      missing: [],
    };
    expect(
      scoreTrajectory(manifest(), [stage()], { reportScore }).reportLegibilityRatio
    ).toBeCloseTo(5 / 7);
  });

  it("leaves report-legibility null when no report score is supplied", () => {
    expect(
      scoreTrajectory(manifest(), [stage()]).reportLegibilityRatio
    ).toBeNull();
  });
});

describe("compareTrajectories", () => {
  it("reports when there are no runs to compare", () => {
    expect(compareTrajectories([])).toBe("No runs to compare.");
  });

  it("renders a stable markdown table with one row per run", () => {
    const out = compareTrajectories([
      { label: "baseline", signals: signals() },
      { label: "panel-on", signals: signals({ costUsd: 0.8 }) },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      "| Run | Succeeded | Exit | Iterations | Stages | Errors | Cost (USD) | Tokens | Elapsed (ms) | Safety events | Skills used | Plan quality | Report legibility |"
    );
    expect(lines[1]).toBe(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    );
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("| baseline |");
    expect(lines[3]).toContain("| panel-on |");
  });

  it("marks best and worst per directional signal", () => {
    const out = compareTrajectories([
      { label: "cheap", signals: signals({ costUsd: 0.2, errorStageCount: 0 }) },
      { label: "pricey", signals: signals({ costUsd: 0.9, errorStageCount: 3 }) },
    ]);
    expect(out).toContain("$0.2 (best)");
    expect(out).toContain("$0.9 (worst)");
    // lower errors win.
    expect(out).toContain("| 0 (best) |");
    expect(out).toContain("| 3 (worst) |");
  });

  it("ranks succeeded as higher-is-better", () => {
    const out = compareTrajectories([
      { label: "ok", signals: signals({ succeeded: true }) },
      { label: "fail", signals: signals({ succeeded: false }) },
    ]);
    expect(out).toContain("yes (best)");
    expect(out).toContain("no (worst)");
  });

  it("does not mark a column where every run ties", () => {
    const out = compareTrajectories([
      { label: "a", signals: signals({ costUsd: 0.5 }) },
      { label: "b", signals: signals({ costUsd: 0.5 }) },
    ]);
    expect(out).not.toContain("(best)");
    expect(out).not.toContain("(worst)");
  });

  it("does not mark anything for a single run", () => {
    const out = compareTrajectories([{ label: "solo", signals: signals() }]);
    expect(out).not.toContain("(best)");
    expect(out).not.toContain("(worst)");
  });

  it("shows a safety-events column but does not rank it", () => {
    const out = compareTrajectories([
      { label: "a", signals: signals({ safetyEventCount: 0 }) },
      { label: "b", signals: signals({ safetyEventCount: 3 }) },
    ]);
    expect(out).toContain("Safety events");
    // A conflated count cannot be honestly ranked (a blocked injection is good
    // detection, not a worse run), so no best/worst markers on the safety column.
    expect(out).not.toContain("3 (worst)");
    expect(out).not.toContain("3 (best)");
    expect(out).not.toContain("0 (best)");
  });

  it("excludes null signals from ranking and renders them as a dash", () => {
    const out = compareTrajectories([
      { label: "finalized", signals: signals({ elapsedMs: 12_000 }) },
      { label: "interrupted", signals: signals({ elapsedMs: null }) },
    ]);
    // Only one run has a comparable elapsed value, so no best/worst marker on it.
    expect(out).toContain("| 12000 |");
    expect(out).toContain("| — |");
  });

  it("ranks plan quality as higher-is-better and renders a percent (#63)", () => {
    const out = compareTrajectories([
      { label: "rich", signals: signals({ planQualityRatio: 1 }) },
      { label: "thin", signals: signals({ planQualityRatio: 0.5 }) },
    ]);
    expect(out).toContain("Plan quality");
    expect(out).toContain("100% (best)");
    expect(out).toContain("50% (worst)");
  });

  it("renders an unscored plan quality as a dash, excluded from ranking", () => {
    const out = compareTrajectories([
      { label: "scored", signals: signals({ planQualityRatio: 0.8 }) },
      { label: "unscored", signals: signals({ planQualityRatio: null }) },
    ]);
    expect(out).toContain("80%");
    expect(out).not.toContain("80% (best)");
  });

  it("ranks report legibility as higher-is-better and renders a percent (#64)", () => {
    const out = compareTrajectories([
      { label: "rich", signals: signals({ reportLegibilityRatio: 1 }) },
      { label: "thin", signals: signals({ reportLegibilityRatio: 3 / 7 }) },
    ]);
    expect(out).toContain("Report legibility");
    expect(out).toContain("100% (best)");
    expect(out).toContain("43% (worst)");
  });

  it("renders an unscored report legibility as a dash, excluded from ranking", () => {
    const out = compareTrajectories([
      { label: "scored", signals: signals({ reportLegibilityRatio: 0.6 }) },
      { label: "unscored", signals: signals({ reportLegibilityRatio: null }) },
    ]);
    expect(out).toContain("60%");
    expect(out).not.toContain("60% (best)");
    expect(out).toContain("Report legibility");
    expect(out).toContain("| — |");
  });
});
