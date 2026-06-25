import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatPlainReport, runExplain } from "../report-explain.js";
import {
  writeManifest,
  writeRunReport,
  type RunManifest,
} from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-explain-"));
}

const manifest: RunManifest = {
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
  artifacts: [],
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:05:00.000Z",
};

const REPORT = [
  "# Otto quality report",
  "",
  "## Verdict",
  "",
  "Needs human review",
  "",
  "## What You Can Now Do",
  "",
  "Issues now close themselves when the fix lands.",
  "",
  "_Engineer detail below — a non-engineer can stop reading here._",
  "",
  "## What Changed",
  "",
  "The issue completion path posts the close-out report.",
  "",
  "## Evidence",
  "",
  "- foo.ts:42",
].join("\n");

describe("formatPlainReport", () => {
  it("leads with the persisted plain report, then the run facts", () => {
    const out = formatPlainReport(manifest, REPORT);
    // The layperson prose leads.
    expect(out).toContain("Issues now close themselves when the fix lands.");
    const reportAt = out.indexOf("# Otto quality report");
    const factsAt = out.indexOf("Run facts");
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeGreaterThan(reportAt);
    // The facts footer carries the bottom line without reading code.
    expect(out).toContain("2 of 5 iterations");
    expect(out).toContain("$1.23");
    expect(out).toContain("39");
    expect(out).toContain("complete");
  });

  it("explains the absence when no report was persisted", () => {
    const out = formatPlainReport(manifest, null);
    expect(out).toMatch(
      /didn't emit a plain-language report|older run|plan\/PRD/
    );
    // Still gives the facts so the run isn't opaque.
    expect(out).toContain("Run facts");
    expect(out).toContain("$1.23");
    expect(out).not.toContain("# Otto quality report");
  });
});

describe("runExplain", () => {
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

  it("renders the persisted report for an explicit run-id and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, manifest);
    writeRunReport(ws, manifest.runId, REPORT);
    const { d, lines } = deps(ws);
    const code = await runExplain([manifest.runId], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Issues now close themselves");
    expect(lines.join("\n")).toContain("Run facts");
  });

  it("falls back to facts when the run emitted no report", async () => {
    const ws = tmp();
    writeManifest(ws, manifest);
    const { d, lines } = deps(ws);
    const code = await runExplain([manifest.runId], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/didn't emit a plain-language report/);
  });

  it("defaults to the latest run for no arg or 'latest'", async () => {
    const ws = tmp();
    writeManifest(ws, { ...manifest, runId: "2026-06-19T00-00-00-000Z-1" });
    const newer = { ...manifest, runId: "2026-06-19T09-00-00-000Z-1" };
    writeManifest(ws, newer);
    writeRunReport(ws, newer.runId, REPORT);

    const a = deps(ws);
    expect(await runExplain([], a.d)).toBe(0);
    expect(a.lines.join("\n")).toContain("Issues now close themselves");

    const b = deps(ws);
    expect(await runExplain(["latest"], b.d)).toBe(0);
    expect(b.lines.join("\n")).toContain("Issues now close themselves");
  });

  it("errors when the run-id is unknown", async () => {
    const ws = tmp();
    writeManifest(ws, manifest);
    const { d, errs } = deps(ws);
    const code = await runExplain(["nope"], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/nope/);
  });

  it("errors when there are no runs at all", async () => {
    const { d, errs } = deps(tmp());
    const code = await runExplain([], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no runs/i);
  });
});
