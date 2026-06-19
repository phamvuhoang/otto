import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatRunsList,
  runRuns,
  summarizeManifest,
  type RunSummary,
} from "../runs-cli.js";
import { writeManifest, type RunManifest } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-runs-"));
}

const base: RunManifest = {
  runId: "2026-06-19T00-00-00-000Z-1",
  bin: "otto-afk",
  mode: "afk",
  inputs: "plan.md",
  runtime: { id: "claude", displayName: "Claude Code" },
  iterations: 5,
  completedIterations: 3,
  costUsd: 1.5,
  tokenUsage: emptyTokenUsage(),
  exitReason: "complete",
  artifacts: [],
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:01:23.000Z",
};

describe("summarizeManifest", () => {
  it("derives the operator fields, including elapsed", () => {
    const s = summarizeManifest(base);
    expect(s).toEqual<RunSummary>({
      runId: "2026-06-19T00-00-00-000Z-1",
      bin: "otto-afk",
      mode: "afk",
      status: "complete",
      iterations: "3/5",
      costUsd: 1.5,
      elapsedMs: 83000,
    });
  });

  it("marks an un-finalized run 'in progress' with unknown iterations + elapsed", () => {
    const s = summarizeManifest({
      ...base,
      completedIterations: undefined,
      exitReason: undefined,
      finishedAt: undefined,
    });
    expect(s.status).toBe("in progress");
    expect(s.iterations).toBe("?/5");
    expect(s.elapsedMs).toBeNull();
  });
});

describe("formatRunsList", () => {
  it("returns a friendly line when there are no runs", () => {
    expect(formatRunsList([])).toMatch(/no runs/i);
  });

  it("renders an aligned table with one row per run", () => {
    const out = formatRunsList([
      summarizeManifest(base),
      summarizeManifest({ ...base, runId: "r2", bin: "otto-ghafk", exitReason: "aborted" }),
    ]);
    expect(out).toContain("RUN ID");
    expect(out).toContain("COST");
    expect(out).toContain("2026-06-19T00-00-00-000Z-1");
    expect(out).toContain("otto-ghafk");
    expect(out).toContain("aborted");
    expect(out).toContain("$1.50");
    expect(out).toContain("1m23s");
  });
});

describe("runRuns", () => {
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

  it("lists runs newest first and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, { ...base, runId: "2026-06-19T00-00-00-000Z-1", exitReason: "aborted" });
    writeManifest(ws, { ...base, runId: "2026-06-19T09-00-00-000Z-1", exitReason: "complete" });
    const { d, lines } = deps(ws);
    expect(await runRuns([], d)).toBe(0);
    const out = lines.join("\n");
    // Newest (09:00) appears before the older (00:00) row.
    expect(out.indexOf("09-00-00")).toBeLessThan(out.indexOf("00-00-00"));
  });

  it("prints the friendly empty message when there are no runs", async () => {
    const { d, lines } = deps(tmp());
    expect(await runRuns(["list"], d)).toBe(0);
    expect(lines.join("\n")).toMatch(/no runs/i);
  });

  it("rejects an unknown subcommand", async () => {
    const { d, errs } = deps(tmp());
    expect(await runRuns(["bogus"], d)).toBe(1);
    expect(errs.join("\n")).toMatch(/unknown subcommand/i);
  });

  it("prints usage on --help", async () => {
    const { d, lines } = deps(tmp());
    expect(await runRuns(["--help"], d)).toBe(0);
    expect(lines.join("\n")).toMatch(/usage: otto-runs/i);
  });
});
