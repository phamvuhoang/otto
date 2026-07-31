import { describe, expect, it } from "vitest";
import {
  checkSignals,
  deriveProgress,
  nextFailureStreak,
  type IterationObservation,
} from "../progress.js";
import { decide } from "../policy.js";
import {
  emptyFindingMemory,
  recordFindings,
  type FindingMemory,
} from "../finding-memory.js";
import type { Finding } from "../review-severity.js";
import type { ChecksRecord } from "../checks.js";

const finding = (claim: string): Finding => ({
  severity: "major",
  file: "src/a.ts",
  claim,
  why: "because",
});

const red: ChecksRecord = {
  command: "pnpm -r test",
  exitCode: 1,
  durationMs: 900,
  outputTail: "FAIL src/a.test.ts > adds\n",
  failureSignature: "FAIL src/a.test.ts > adds",
  attestedAt: "2026-07-31T00:00:00.000Z",
};
const green: ChecksRecord = { ...red, exitCode: 0, failureSignature: null };

/** Drive the loop's per-iteration signal chain without spawning a loop. */
function runIterations(
  iterations: { checks: ChecksRecord[]; findings: Finding[]; diff: string }[]
) {
  let memory: FindingMemory = emptyFindingMemory();
  let prev: IterationObservation | null = null;
  let prevSig: string | null = null;
  let streak = 0;
  let stalled = 0;
  const decisions: { action: string; reason: string }[] = [];

  iterations.forEach((it, idx) => {
    const i = idx + 1;
    const checks = checkSignals(it.checks);
    const folded = recordFindings(memory, i, it.findings);
    memory = folded.memory;
    const cur: IterationObservation = {
      diffSignature: it.diff,
      failingChecks: checks.failingChecks,
      failureSignature: checks.failureSignature,
      findingSignatures: folded.recurring.map((e) => e.signature),
      cumulativeCostUsd: i,
    };
    stalled = it.diff === prev?.diffSignature ? stalled + 1 : 0;
    streak = nextFailureStreak(prevSig, checks.failureSignature, streak);
    prevSig = checks.failureSignature;
    const signals = deriveProgress(cur, prev);
    prev = cur;
    decisions.push(
      decide(signals, {
        stalledIterations: stalled,
        repeatedFailureStreak: streak,
        recurringFindingCount: folded.recurring.length,
        failingChecks: null, // D1: the loop holds this null
      })
    );
  });
  return decisions;
}

describe("recurring-defect fixture (roadmap success metric)", () => {
  it("escalates within one iteration of a defect's SECOND appearance", () => {
    const defect = finding("null deref on the empty path");
    const decisions = runIterations([
      { checks: [green], findings: [defect], diff: "a" },
      { checks: [green], findings: [], diff: "b" }, // "fixed"
      { checks: [green], findings: [defect], diff: "c" }, // it came back
    ]);
    expect(decisions[0].action).toBe("continue");
    expect(decisions[1].action).toBe("continue");
    expect(decisions[2].action).toBe("escalate-pause");
    expect(decisions[2].reason).toMatch(/came back/i);
  });

  it("escalates a check failure that recurs three iterations running", () => {
    const decisions = runIterations([
      { checks: [red], findings: [], diff: "a" },
      { checks: [red], findings: [], diff: "b" },
      { checks: [red], findings: [], diff: "c" },
    ]);
    expect(decisions[2].action).toBe("escalate-pause");
    expect(decisions[2].reason).toMatch(/same failure/i);
  });

  it("does NOT escalate a run that is steadily improving", () => {
    const decisions = runIterations([
      { checks: [red, red], findings: [finding("x")], diff: "a" },
      { checks: [red], findings: [], diff: "b" },
      { checks: [green], findings: [], diff: "c" },
    ]);
    expect(decisions.map((d) => d.action)).toEqual([
      "continue",
      "continue",
      "continue",
    ]);
  });

  it("a green run never short-circuits to a confident finish (D1)", () => {
    const decisions = runIterations([
      { checks: [green], findings: [], diff: "a" },
      { checks: [green], findings: [], diff: "b" },
    ]);
    expect(decisions).not.toContainEqual(
      expect.objectContaining({ action: "finish-confident" })
    );
  });

  it("is fully inert for an unconfigured repo (no attested checks)", () => {
    const decisions = runIterations([
      { checks: [], findings: [], diff: "a" },
      { checks: [], findings: [], diff: "b" },
    ]);
    expect(decisions.map((d) => d.action)).toEqual(["continue", "continue"]);
  });
});
