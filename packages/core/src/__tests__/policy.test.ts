import { describe, expect, it } from "vitest";

import { decide, type PolicyContext } from "../policy.js";
import type { ProgressSignals } from "../progress.js";

function signals(overrides: Partial<ProgressSignals> = {}): ProgressSignals {
  return {
    diffChanged: true,
    checksDelta: 1,
    repeatedFailure: false,
    recurringFindings: [],
    costBurnRateUsd: 0.2,
    ...overrides,
  };
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    stalledIterations: 0,
    repeatedFailureStreak: 0,
    failingChecks: 3,
    ...overrides,
  };
}

describe("decide", () => {
  it("continues while the run is making progress", () => {
    expect(decide(signals(), ctx()).action).toBe("continue");
  });

  it("escalates to a human pause when a failure repeats past the threshold", () => {
    const d = decide(signals({ repeatedFailure: true }), ctx({ repeatedFailureStreak: 3 }));
    expect(d.action).toBe("escalate-pause");
    expect(d.reason).toMatch(/repeat|human/i);
  });

  it("finishes confidently when checks are green", () => {
    const d = decide(signals({ diffChanged: false }), ctx({ failingChecks: 0 }));
    expect(d.action).toBe("finish-confident");
  });

  it("stops on low marginal progress when stalled without improvement", () => {
    const d = decide(
      signals({ diffChanged: false, checksDelta: 0 }),
      ctx({ stalledIterations: 2, failingChecks: 2 })
    );
    expect(d.action).toBe("stop-low-progress");
  });

  it("treats a null checksDelta as no improvement when stalled", () => {
    const d = decide(
      signals({ diffChanged: false, checksDelta: null }),
      ctx({ stalledIterations: 2, failingChecks: 2 })
    );
    expect(d.action).toBe("stop-low-progress");
  });

  it("keeps going when only stalled for a single iteration", () => {
    expect(
      decide(signals({ diffChanged: false, checksDelta: 0 }), ctx({ stalledIterations: 1 }))
        .action
    ).toBe("continue");
  });

  it("escalation outranks a stall (a human is needed even if also stalled)", () => {
    const d = decide(
      signals({ diffChanged: false, repeatedFailure: true }),
      ctx({ repeatedFailureStreak: 4, stalledIterations: 3, failingChecks: 2 })
    );
    expect(d.action).toBe("escalate-pause");
  });

  it("a confident finish outranks a stall (green even if the diff settled)", () => {
    const d = decide(
      signals({ diffChanged: false, checksDelta: 0 }),
      ctx({ stalledIterations: 3, failingChecks: 0 })
    );
    expect(d.action).toBe("finish-confident");
  });
});
