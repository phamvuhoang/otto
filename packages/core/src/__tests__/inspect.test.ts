import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatRunReport, runInspect } from "../inspect.js";
import {
  writeManifest,
  writeRunReport,
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

  it("surfaces injected skills per stage and in a run-level section (P18)", () => {
    const withSkill: StageRecord = {
      ...implStage,
      skillsUsed: [
        {
          name: "tdd",
          version: "1.0.0",
          source: "superpowers",
          ref: "abc1234",
          stage: "implementer",
          reasons: ["afk-safe (usable on any stage)"],
        },
      ],
    };
    const manifest: RunManifest = {
      ...finalized,
      skillsUsed: [
        {
          name: "tdd",
          version: "1.0.0",
          source: "superpowers",
          stage: "implementer",
        },
      ],
    };
    const out = formatRunReport(manifest, [withSkill, reviewerStage]);
    expect(out).toMatch(/skills/i);
    expect(out).toContain("tdd");
    expect(out).toContain("superpowers");
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

  it("--plain with an explicit id prints the plain report and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeRunReport(ws, finalized.runId, "# Otto quality report\nAll good.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain", finalized.runId], d);
    expect(code).toBe(0);
    const out = lines.join("\n");
    // plain report contains the persisted prose
    expect(out).toContain("All good.");
    // run-facts footer is present
    expect(out).toContain("Run facts");
    expect(out).toContain("otto-ghafk");
    // engineer detail is NOT the primary render (no stage table)
    expect(out).not.toContain("Stages (");
  });

  it("--plain after the run-id also works (flag may appear anywhere)", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeRunReport(ws, finalized.runId, "# Otto quality report\nDone.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId, "--plain"], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Done.");
  });

  it("--plain with no run-id defaults to the latest run", async () => {
    const ws = tmp();
    const older: RunManifest = {
      ...finalized,
      runId: "2026-06-19T00-00-00-000Z-1",
    };
    const newer: RunManifest = {
      ...finalized,
      runId: "2026-06-19T09-00-00-000Z-1",
    };
    writeManifest(ws, older);
    writeManifest(ws, newer);
    writeRunReport(ws, newer.runId, "# Otto quality report\nNewest run.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain"], d);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Newest run.");
    // Facts footer identifies the newer run's bin/mode
    expect(out).toContain("otto-ghafk");
  });

  it("--plain with an unknown id still errors and exits 1", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    const { d, errs } = deps(ws);
    const code = await runInspect(["--plain", "does-not-exist"], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does-not-exist/);
  });

  it("--plain falls back gracefully when no report was persisted", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    // No writeRunReport — run emitted no quality report
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain", finalized.runId], d);
    expect(code).toBe(0);
    // should still print something (fallback message + facts)
    expect(lines.join("\n")).toMatch(/Run facts|no.*report|plain-language/i);
  });

  it("without --plain the engineer report is unchanged (byte-for-byte same path)", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeStageRecord(ws, finalized.runId, 0, implStage);
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId], d);
    expect(code).toBe(0);
    // Engineer report still has stage table
    expect(lines.join("\n")).toContain("Stages (");
  });
});
