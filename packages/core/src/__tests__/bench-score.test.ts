import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateExpectation,
  runFixtureChecks,
  type BenchmarkCheck,
} from "../bench.js";
import type { EvalSignals } from "../eval.js";

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
    ...overrides,
  };
}

describe("runFixtureChecks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otto-bench-fix-"));
    writeFileSync(join(dir, "marker.txt"), "present");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a check whose command exits 0 in the fixture and fails one that does not", () => {
    const checks: BenchmarkCheck[] = [
      { name: "present", command: `node -e "require('fs').statSync('marker.txt')"` },
      { name: "absent", command: `node -e "require('fs').statSync('nope.txt')"` },
    ];
    const results = runFixtureChecks(checks, dir);
    expect(results).toEqual([
      { name: "present", passed: true },
      { name: "absent", passed: false },
    ]);
  });

  it("returns an empty list for no checks", () => {
    expect(runFixtureChecks([], dir)).toEqual([]);
  });

  it("uses the injected runner with the fixture cwd", () => {
    const seen: Array<{ command: string; cwd: string }> = [];
    const results = runFixtureChecks(
      [{ name: "c", command: "pnpm test" }],
      "/work/fixture",
      (command, cwd) => {
        seen.push({ command, cwd });
        return { status: 0 };
      }
    );
    expect(seen).toEqual([{ command: "pnpm test", cwd: "/work/fixture" }]);
    expect(results).toEqual([{ name: "c", passed: true }]);
  });

  it("treats a null exit status (killed/spawn failure) as failed", () => {
    const results = runFixtureChecks(
      [{ name: "c", command: "x" }],
      "/work",
      () => ({ status: null })
    );
    expect(results).toEqual([{ name: "c", passed: false }]);
  });
});

describe("evaluateExpectation", () => {
  it("passes an empty expectation", () => {
    const v = evaluateExpectation({}, signals(), []);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it("fails when succeeded does not match", () => {
    const v = evaluateExpectation({ succeeded: true }, signals({ succeeded: false }), []);
    expect(v.passed).toBe(false);
    expect(v.failures.join(" ")).toMatch(/succeeded/);
  });

  it("fails when cost exceeds the ceiling", () => {
    const v = evaluateExpectation({ maxCostUsd: 1.0 }, signals({ costUsd: 1.5 }), []);
    expect(v.passed).toBe(false);
    expect(v.failures.join(" ")).toMatch(/cost/i);
  });

  it("passes when cost is within the ceiling", () => {
    const v = evaluateExpectation({ maxCostUsd: 1.0 }, signals({ costUsd: 0.5 }), []);
    expect(v.passed).toBe(true);
  });

  it("fails when any fixture check failed", () => {
    const v = evaluateExpectation({ succeeded: true }, signals(), [
      { name: "tests", passed: false },
    ]);
    expect(v.passed).toBe(false);
    expect(v.failures.join(" ")).toMatch(/tests/);
  });

  it("accumulates every failure", () => {
    const v = evaluateExpectation(
      { succeeded: true, maxCostUsd: 0.1 },
      signals({ succeeded: false, costUsd: 9 }),
      [{ name: "tests", passed: false }]
    );
    expect(v.failures).toHaveLength(3);
  });
});
