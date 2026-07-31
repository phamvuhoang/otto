import { describe, expect, it } from "vitest";
import { decide } from "../policy.js";
import type { ProgressSignals } from "../progress.js";

const signals = (over: Partial<ProgressSignals> = {}): ProgressSignals => ({
  diffChanged: true,
  checksDelta: null,
  repeatedFailure: false,
  recurringFindings: [],
  costBurnRateUsd: 1,
  ...over,
});

const ctx = (over = {}) => ({
  stalledIterations: 0,
  repeatedFailureStreak: 0,
  failingChecks: null,
  ...over,
});

describe("recurring-finding escalation", () => {
  it("escalates when a fixed defect comes back", () => {
    const d = decide(
      signals({ recurringFindings: ["major|src/a.ts|leak"] }),
      ctx({ recurringFindingCount: 1 })
    );
    expect(d.action).toBe("escalate-pause");
    expect(d.reason).toMatch(/came back|recurr/i);
  });

  it("outranks a green-checks confident finish", () => {
    // A green suite does not clear a re-raised review finding.
    const d = decide(
      signals({ recurringFindings: ["major|src/a.ts|leak"] }),
      ctx({ recurringFindingCount: 1, failingChecks: 0 })
    );
    expect(d.action).toBe("escalate-pause");
  });

  it("still yields to a repeated check failure, which is more specific", () => {
    const d = decide(
      signals({ recurringFindings: ["major|src/a.ts|leak"] }),
      ctx({ recurringFindingCount: 1, repeatedFailureStreak: 3 })
    );
    expect(d.action).toBe("escalate-pause");
    expect(d.reason).toMatch(/same failure/i);
  });

  it("is absent by default — existing call sites are unchanged", () => {
    expect(decide(signals(), ctx()).action).toBe("continue");
  });
});

describe("D1: green attested checks must NOT end the run", () => {
  // This is the trap P28's spec holds shut. policy.ts returns finish-confident
  // when ctx.failingChecks === 0, and loop.ts maps that action to exit reason
  // "complete" + return outcome() — it ENDS the run, with no verify stage and
  // no consultation of the gate that decides whether tasks remain. Because the
  // field has always been hardcoded null, that branch has never executed.
  it("returns continue when the loop holds failingChecks at null", () => {
    const d = decide(
      signals({ checksDelta: 2 }),
      ctx({ failingChecks: null, recurringFindingCount: 0 })
    );
    expect(d.action).toBe("continue");
    expect(d.action).not.toBe("finish-confident");
  });

  it("documents the trap: passing the count through would end the run", () => {
    // Asserting the consequence keeps the reason discoverable at exactly the
    // point someone would be tempted to "finish the wiring".
    const d = decide(signals(), ctx({ failingChecks: 0 }));
    expect(d.action).toBe("finish-confident"); // <- the trap, proven
  });
});
