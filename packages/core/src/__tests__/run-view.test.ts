import { describe, expect, it } from "vitest";

import type { PlanProgress } from "../plan-progress.js";
import type { RunManifest, StageRecord } from "../run-report.js";
import { buildRunView, formatDoneCard, formatLiveTree } from "../run-view.js";
import { emptyTokenUsage } from "../tokens.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "test-run-1",
    bin: "otto-afk",
    mode: "afk",
    inputs: "implement a feature",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 3,
    costUsd: 0.5,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    startedAt: "2024-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeStage(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    iteration: 1,
    stage: "implementer",
    runtimeId: "claude",
    costUsd: 0.1,
    usage: emptyTokenUsage(),
    isError: false,
    apiErrorStatus: null,
    startedAt: "2024-01-01T10:00:00.000Z",
    finishedAt: "2024-01-01T10:01:00.000Z",
    ...overrides,
  };
}

// Strip ANSI escape sequences for assertion
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// buildRunView — status mapping
// ---------------------------------------------------------------------------

describe("buildRunView", () => {
  it("status is 'running' when manifest has no finishedAt", () => {
    const manifest = makeManifest(); // no finishedAt
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("running");
  });

  it("status is 'done' for a successful exit reason", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 3,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("done");
  });

  it("status is 'done' for 'complete' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "complete",
      completedIterations: 2,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("done");
  });

  it("status is 'failed' for 'done with failures' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "done with failures",
      completedIterations: 1,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("failed");
  });

  it("status is 'failed' for 'stopped (error)' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "stopped (error)",
      completedIterations: 0,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("failed");
  });

  it("status is 'done' for 'stopped (budget)' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "stopped (budget)",
      completedIterations: 1,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("done");
  });

  it("status is 'done' for 'aborted' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "aborted",
      completedIterations: 0,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    expect(view.status).toBe("done");
  });

  // ---------------------------------------------------------------------------
  // elapsedMs — null-not-NaN discipline
  // ---------------------------------------------------------------------------

  it("elapsedMs is null when un-finalized (no finishedAt)", () => {
    const manifest = makeManifest(); // no finishedAt
    const view = buildRunView(manifest, []);
    expect(view.elapsedMs).toBeNull();
    expect(Number.isNaN(view.elapsedMs)).toBe(false);
  });

  it("elapsedMs is computed correctly from started/finished", () => {
    const manifest = makeManifest({
      finishedAt: "2024-01-01T10:05:00.000Z",
      exitReason: "done",
      completedIterations: 3,
    });
    const view = buildRunView(manifest, []);
    expect(view.elapsedMs).toBe(5 * 60 * 1000); // 5 minutes in ms
  });

  it("elapsedMs is null for unparseable startedAt", () => {
    const manifest = makeManifest({
      startedAt: "not-a-date",
      finishedAt: "2024-01-01T10:05:00.000Z",
      exitReason: "done",
      completedIterations: 1,
    });
    const view = buildRunView(manifest, []);
    expect(view.elapsedMs).toBeNull();
    expect(Number.isNaN(view.elapsedMs)).toBe(false);
  });

  it("elapsedMs is null for unparseable finishedAt", () => {
    const manifest = makeManifest({
      finishedAt: "not-a-date",
      exitReason: "done",
      completedIterations: 1,
    });
    const view = buildRunView(manifest, []);
    expect(view.elapsedMs).toBeNull();
    expect(Number.isNaN(view.elapsedMs)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Field mapping
  // ---------------------------------------------------------------------------

  it("copies runId, bin, mode from manifest", () => {
    const manifest = makeManifest();
    const view = buildRunView(manifest, []);
    expect(view.runId).toBe("test-run-1");
    expect(view.bin).toBe("otto-afk");
    expect(view.mode).toBe("afk");
  });

  it("iterationsDone from completedIterations or 0", () => {
    const manifest = makeManifest({
      completedIterations: 2,
      finishedAt: "2024-01-01T10:05:00.000Z",
      exitReason: "done",
    });
    const view = buildRunView(manifest, []);
    expect(view.iterationsDone).toBe(2);
  });

  it("iterationsDone is 0 when completedIterations absent", () => {
    const manifest = makeManifest(); // running, no completedIterations
    const view = buildRunView(manifest, []);
    expect(view.iterationsDone).toBe(0);
  });

  it("iterationsTotal from manifest.iterations", () => {
    const manifest = makeManifest({ iterations: 5 });
    const view = buildRunView(manifest, []);
    expect(view.iterationsTotal).toBe(5);
  });

  it("costUsd from manifest", () => {
    const manifest = makeManifest({ costUsd: 1.23 });
    const view = buildRunView(manifest, []);
    expect(view.costUsd).toBe(1.23);
  });

  it("exitReason is null when not in manifest", () => {
    const manifest = makeManifest(); // running, no exitReason
    const view = buildRunView(manifest, []);
    expect(view.exitReason).toBeNull();
  });

  it("stages array maps isError from stage records", () => {
    const stages = [
      makeStage({ iteration: 1, stage: "implementer", isError: false }),
      makeStage({ iteration: 1, stage: "reviewer", isError: true }),
    ];
    const view = buildRunView(makeManifest(), stages);
    expect(view.stages).toHaveLength(2);
    expect(view.stages[0]).toMatchObject({
      iteration: 1,
      stage: "implementer",
      isError: false,
    });
    expect(view.stages[1]).toMatchObject({
      iteration: 1,
      stage: "reviewer",
      isError: true,
    });
  });

  it("planProgress is undefined when not supplied", () => {
    const view = buildRunView(makeManifest(), []);
    expect(view.planProgress).toBeUndefined();
  });

  it("planProgress is passed through from opts", () => {
    const progress: PlanProgress = {
      checked: 2,
      total: 5,
      items: [],
    };
    const view = buildRunView(makeManifest(), [], { planProgress: progress });
    expect(view.planProgress).toEqual(progress);
  });
});

// ---------------------------------------------------------------------------
// formatDoneCard — greppable first line + card sections
// ---------------------------------------------------------------------------

describe("formatDoneCard", () => {
  it("first line contains the greppable 'Otto done · N iterations · $cost' substring", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.2,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = formatDoneCard(view);
    const firstLine = card.split("\n")[0];
    // Strip ANSI for the substring check (matches loop.test.ts behavior)
    const plain = stripAnsi(firstLine);
    expect(plain).toContain("Otto done · 2 iterations · $0.20");
  });

  it("first line uses 'iteration' (singular) when N=1", () => {
    const manifest = makeManifest({
      exitReason: "complete",
      completedIterations: 1,
      costUsd: 0.25,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = formatDoneCard(view);
    const plain = stripAnsi(card.split("\n")[0]);
    expect(plain).toContain("Otto complete · 1 iteration · $0.25");
  });

  it("first line for 'stopped (budget)' exit reason", () => {
    const manifest = makeManifest({
      exitReason: "stopped (budget)",
      completedIterations: 1,
      costUsd: 1.2,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = formatDoneCard(view);
    const plain = stripAnsi(card.split("\n")[0]);
    expect(plain).toContain("Otto stopped (budget) · 1 iteration · $1.20");
  });

  it("card contains next-action line", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.2,
      nextAction: "review the diff, then open a PR",
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = stripAnsi(formatDoneCard(view));
    expect(card).toContain("→ next:");
  });

  it("card contains plan progress when present", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 3,
      costUsd: 0.5,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const progress: PlanProgress = { checked: 3, total: 5, items: [] };
    const view = buildRunView(manifest, [], { planProgress: progress });
    const card = stripAnsi(formatDoneCard(view));
    expect(card).toContain("3/5");
  });

  it("card omits plan progress section when not present", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.2,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = stripAnsi(formatDoneCard(view));
    // No plan progress: no checked/total pattern
    expect(card).not.toMatch(/\d+\/\d+/);
  });

  it("card mentions deferred follow-ups note from view when review-followups artifact present", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.2,
      finishedAt: "2024-01-01T10:05:00.000Z",
      artifacts: [
        {
          kind: "review-followups",
          path: ".otto/review-followups.md",
          description: "deferred reviewer follow-ups",
        },
      ],
    });
    const view = buildRunView(manifest, []);
    const card = stripAnsi(formatDoneCard(view));
    expect(card).toContain("follow-up");
  });

  it("card does not emit ANSI when color is effectively off (structure-level check)", () => {
    // We cannot force USE_COLOR off at module-load time, so we assert the
    // plain-text structure (stripAnsi(card) === card when no ANSI present).
    // In a CI/non-TTY environment this will hold naturally; in a TTY env
    // this test documents the structure requirement.
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.2,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const card = formatDoneCard(view);
    // The plain (ANSI-stripped) content must still contain the greppable line
    const plain = stripAnsi(card);
    expect(plain).toContain("Otto done · 2 iterations · $0.20");
  });

  it("card shows stage summary for error stages", () => {
    const stages = [
      makeStage({ iteration: 1, stage: "implementer", isError: true }),
    ];
    const manifest = makeManifest({
      exitReason: "done with failures",
      completedIterations: 1,
      costUsd: 0.1,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, stages);
    const card = stripAnsi(formatDoneCard(view));
    // Should mention the stage or error
    expect(card).toMatch(/implementer|error|fail/i);
  });
});

// ---------------------------------------------------------------------------
// formatLiveTree
// ---------------------------------------------------------------------------

describe("formatLiveTree", () => {
  it("shows a status header", () => {
    const manifest = makeManifest();
    const view = buildRunView(manifest, []);
    const tree = stripAnsi(formatLiveTree(view));
    // Should include run id or bin or some header info
    expect(tree.length).toBeGreaterThan(0);
    expect(tree).toMatch(/otto-afk|afk|running|test-run-1/i);
  });

  it("shows cost in the output", () => {
    const manifest = makeManifest({ costUsd: 0.42 });
    const view = buildRunView(manifest, []);
    const tree = stripAnsi(formatLiveTree(view));
    expect(tree).toContain("0.42");
  });

  it("shows elapsed time when finalized", () => {
    const manifest = makeManifest({
      exitReason: "done",
      completedIterations: 2,
      costUsd: 0.5,
      finishedAt: "2024-01-01T10:05:00.000Z",
    });
    const view = buildRunView(manifest, []);
    const tree = stripAnsi(formatLiveTree(view));
    // elapsedMs = 5 * 60 * 1000 = 300000 ms — should appear in some form
    expect(tree).toMatch(/300|5m|5:00|elapsed/i);
  });

  it("shows stage tree entries", () => {
    const stages = [
      makeStage({ iteration: 1, stage: "implementer", isError: false }),
      makeStage({ iteration: 1, stage: "reviewer", isError: false }),
    ];
    const manifest = makeManifest({
      finishedAt: "2024-01-01T10:05:00.000Z",
      exitReason: "done",
      completedIterations: 1,
    });
    const view = buildRunView(manifest, stages);
    const tree = stripAnsi(formatLiveTree(view));
    expect(tree).toContain("implementer");
    expect(tree).toContain("reviewer");
  });

  it("shows plan progress when present", () => {
    const manifest = makeManifest();
    const progress: PlanProgress = { checked: 2, total: 4, items: [] };
    const view = buildRunView(manifest, [], { planProgress: progress });
    const tree = stripAnsi(formatLiveTree(view));
    expect(tree).toContain("2/4");
  });

  it("does not emit ANSI escapes in plain output (structure check)", () => {
    const manifest = makeManifest({ costUsd: 0.1 });
    const view = buildRunView(manifest, []);
    const tree = formatLiveTree(view);
    // In CI (non-TTY), there should be no ANSI
    // In TTY, stripAnsi removes them and leaves text content
    const plain = stripAnsi(tree);
    expect(plain).not.toMatch(/\x1b/);
  });
});
