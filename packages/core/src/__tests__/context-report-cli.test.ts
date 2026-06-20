import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ContextBreakdown } from "../context-report.js";
import {
  formatContextReportRun,
  runContextReport,
} from "../context-report-cli.js";
import { writeStageRecord, type StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-ctx-report-"));
}

function breakdown(
  totalChars: number,
  segs: Array<[string, number]>
): ContextBreakdown {
  return {
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 4),
    segments: segs.map(([category, chars]) => ({
      category: category as ContextBreakdown["segments"][number]["category"],
      chars,
      estimatedTokens: Math.ceil(chars / 4),
    })),
  };
}

function stage(
  iteration: number,
  name: string,
  b?: ContextBreakdown,
  usage = emptyTokenUsage()
): StageRecord {
  return {
    iteration,
    stage: name,
    runtimeId: "claude",
    costUsd: 0,
    usage,
    isError: false,
    apiErrorStatus: null,
    contextBreakdown: b,
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:00:01.000Z",
  };
}

describe("formatContextReportRun", () => {
  it("reports nothing measurable when no stage carries a breakdown", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer"),
      stage(1, "reviewer"),
    ]);
    expect(out).toContain("run-1");
    expect(out).toMatch(/no context breakdown/i);
  });

  it("renders per-stage composition with category shares and an estimate label", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer", breakdown(1000, [["learnings", 400], ["playbook", 600]])),
    ]);
    expect(out).toContain("iter1");
    expect(out).toContain("implementer");
    // est tokens = ceil(1000/4) = 250, labelled with ~
    expect(out).toContain("~250");
    expect(out).toContain("learnings 40%");
    expect(out).toContain("playbook 60%");
  });

  it("flags a growing token slope across iterations", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer", breakdown(400, [["playbook", 400]])), // ~100
      stage(2, "implementer", breakdown(800, [["playbook", 800]])), // ~200
      stage(3, "implementer", breakdown(1600, [["playbook", 1600]])), // ~400
    ]);
    expect(out).toMatch(/slope/i);
    expect(out).toContain("growing");
    expect(out).toContain("~100");
    expect(out).toContain("~400");
  });

  it("labels a near-flat slope as flat (bounded)", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer", breakdown(400, [["playbook", 400]])), // ~100
      stage(2, "implementer", breakdown(420, [["playbook", 420]])), // ~105
      stage(3, "implementer", breakdown(400, [["playbook", 400]])), // ~100
    ]);
    expect(out).toContain("flat");
    expect(out).not.toContain("growing");
  });

  it("reports cache-hit rate from per-stage usage (slice 4)", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer", breakdown(400, [["playbook", 400]]), {
        inputTokens: 1000,
        outputTokens: 50,
        cacheCreationInputTokens: 4000,
        cacheReadInputTokens: 0,
      }),
      stage(2, "implementer", breakdown(400, [["playbook", 400]]), {
        inputTokens: 1000,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4000,
      }),
    ]);
    expect(out).toMatch(/cache efficiency/i);
    expect(out).toContain("40%");
    expect(out).toContain("cache read 4,000");
  });

  it("omits the cache line when no input tokens were recorded", () => {
    const out = formatContextReportRun("run-1", [
      stage(1, "implementer", breakdown(400, [["playbook", 400]])),
    ]);
    expect(out).not.toMatch(/cache efficiency/i);
  });
});

describe("runContextReport", () => {
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

  it("errors with exit 1 when there are no runs", async () => {
    const { d, errs } = deps(tmp());
    expect(await runContextReport(d)).toBe(1);
    expect(errs.join("\n")).toMatch(/no runs/i);
  });

  it("reads the latest run's stage records and prints the report", async () => {
    const ws = tmp();
    const older = "2026-06-20T00-00-00-000Z-1";
    const newer = "2026-06-20T09-00-00-000Z-1";
    writeStageRecord(ws, older, 0, stage(1, "implementer", breakdown(800, [["playbook", 800]])));
    writeStageRecord(
      ws,
      newer,
      0,
      stage(1, "implementer", breakdown(1000, [["learnings", 400], ["playbook", 600]]))
    );
    const { d, lines } = deps(ws);
    expect(await runContextReport(d)).toBe(0);
    const out = lines.join("\n");
    // Reports the newest run, not the older one.
    expect(out).toContain(newer);
    expect(out).toContain("learnings 40%");
  });
});
