import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEvalConfigs, runEval, type EvalDeps } from "../eval-run.js";
import type { RunManifest, StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "r",
    bin: "otto-afk",
    mode: "afk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 3,
    completedIterations: 1,
    costUsd: 0.5,
    tokenUsage: emptyTokenUsage(),
    exitReason: "complete",
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:10.000Z",
    artifacts: [],
    ...overrides,
  };
}

describe("parseEvalConfigs", () => {
  it("parses configs and fills defaults", () => {
    const configs = parseEvalConfigs([
      { label: "baseline" },
      { label: "panel", args: ["--review-panel"], env: { OTTO_RUNNER: "host" } },
    ]);
    expect(configs[0]).toEqual({ label: "baseline", args: [], env: {} });
    expect(configs[1]).toEqual({
      label: "panel",
      args: ["--review-panel"],
      env: { OTTO_RUNNER: "host" },
    });
  });

  it("rejects a non-array", () => {
    expect(() => parseEvalConfigs({})).toThrow(/array/);
  });

  it("rejects a config missing a label", () => {
    expect(() => parseEvalConfigs([{ args: [] }])).toThrow(/label/);
  });
});

describe("runEval", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let invoked: Array<{ bin: string; label: string; args: string[]; env: Record<string, string> }>;

  function deps(overrides: Partial<EvalDeps> = {}): EvalDeps {
    return {
      env: {},
      cwd: dir,
      out: (m) => out.push(m),
      err: (m) => err.push(m),
      invoke: vi.fn(async (inv) => {
        invoked.push({
          bin: inv.bin,
          label: inv.config.label,
          args: inv.args,
          env: inv.config.env,
        });
        return { runId: `${inv.task.id}:${inv.config.label}` };
      }),
      readManifest: () => manifest(),
      readStageRecords: (): StageRecord[] => [],
      runChecks: () => [],
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otto-eval-"));
    out = [];
    err = [];
    invoked = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSuite(tasks: unknown): string {
    const p = join(dir, "suite.json");
    writeFileSync(p, JSON.stringify(tasks));
    return p;
  }

  const task = {
    id: "bug-fix",
    kind: "bug-fix",
    fixture: "fixtures/bug-fix",
    bin: "otto-afk",
    inputs: "fix it",
    expect: { succeeded: true },
  };

  it("prints usage and exits 0 on --help", async () => {
    const code = await runEval(["--help"], deps());
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Usage: otto-eval/);
  });

  it("errors when no suite is given", async () => {
    const code = await runEval([], deps());
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/suite/i);
  });

  it("replays each task across each config and reports a comparison per task", async () => {
    const suite = writeSuite([task]);
    const configsPath = join(dir, "configs.json");
    writeFileSync(
      configsPath,
      JSON.stringify([{ label: "baseline" }, { label: "panel", args: ["--review-panel"] }])
    );

    const code = await runEval([suite, configsPath], deps());

    expect(invoked).toHaveLength(2);
    expect(invoked.map((i) => i.label)).toEqual(["baseline", "panel"]);
    expect(invoked[0].bin).toBe("otto-afk");
    const report = out.join("\n");
    expect(report).toMatch(/bug-fix/);
    expect(report).toContain("| baseline |");
    expect(report).toContain("| panel |");
    expect(code).toBe(0);
  });

  it("defaults to a single config when none is given", async () => {
    const suite = writeSuite([task]);
    const code = await runEval([suite], deps());
    expect(invoked).toHaveLength(1);
    expect(invoked[0].label).toBe("default");
    expect(code).toBe(0);
  });

  it("returns 1 and marks FAIL when an expectation is not met", async () => {
    const suite = writeSuite([task]);
    const code = await runEval([suite], deps({
      readManifest: () => manifest({ exitReason: "stopped (budget)" }),
    }));
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/FAIL/);
  });

  it("runs fixture checks in the task's fixture dir", async () => {
    const suite = writeSuite([
      { ...task, expect: { succeeded: true, checks: [{ name: "tests", command: "pnpm test" }] } },
    ]);
    const runChecks = vi.fn(() => [{ name: "tests", passed: true }]);
    await runEval([suite], deps({ runChecks }));
    expect(runChecks).toHaveBeenCalledTimes(1);
    const [checks, cwd] = runChecks.mock.calls[0];
    expect(checks).toEqual([{ name: "tests", command: "pnpm test" }]);
    expect(cwd).toBe(join(dir, "fixtures/bug-fix"));
  });

  it("passes the iterations flag through to the invoker", async () => {
    const suite = writeSuite([task]);
    const captured: number[] = [];
    await runEval([suite, "--iterations", "5"], deps({
      invoke: vi.fn(async (inv) => {
        captured.push(inv.iterations);
        return { runId: "r" };
      }),
    }));
    expect(captured).toEqual([5]);
  });
});
