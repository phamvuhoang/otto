import { describe, expect, it } from "vitest";

import { deriveProgress, type IterationObservation } from "../progress.js";

function obs(overrides: Partial<IterationObservation> = {}): IterationObservation {
  return {
    diffSignature: "sig-a",
    failingChecks: 2,
    failureSignature: "TypeError: x",
    findingSignatures: ["f1", "f2"],
    cumulativeCostUsd: 1.0,
    ...overrides,
  };
}

describe("deriveProgress", () => {
  it("treats the first iteration (no prior) as changed with unknown deltas", () => {
    const s = deriveProgress(obs({ cumulativeCostUsd: 0.4 }));
    expect(s.diffChanged).toBe(true);
    expect(s.checksDelta).toBeNull();
    expect(s.repeatedFailure).toBe(false);
    expect(s.recurringFindings).toEqual([]);
    expect(s.costBurnRateUsd).toBe(0.4);
  });

  it("flags an unchanged diff against the prior iteration", () => {
    const prev = obs({ diffSignature: "sig-a" });
    const s = deriveProgress(obs({ diffSignature: "sig-a" }), prev);
    expect(s.diffChanged).toBe(false);
  });

  it("flags a changed diff against the prior iteration", () => {
    const prev = obs({ diffSignature: "sig-a" });
    const s = deriveProgress(obs({ diffSignature: "sig-b" }), prev);
    expect(s.diffChanged).toBe(true);
  });

  it("computes checksDelta as failures removed (positive = improving)", () => {
    const prev = obs({ failingChecks: 5 });
    const s = deriveProgress(obs({ failingChecks: 2 }), prev);
    expect(s.checksDelta).toBe(3);
  });

  it("returns a null checksDelta when either side is unknown", () => {
    expect(deriveProgress(obs({ failingChecks: null }), obs()).checksDelta).toBeNull();
    expect(deriveProgress(obs(), obs({ failingChecks: null })).checksDelta).toBeNull();
  });

  it("detects a repeated failure signature", () => {
    const prev = obs({ failureSignature: "TypeError: x" });
    expect(deriveProgress(obs({ failureSignature: "TypeError: x" }), prev).repeatedFailure).toBe(
      true
    );
    expect(deriveProgress(obs({ failureSignature: "Other" }), prev).repeatedFailure).toBe(false);
  });

  it("does not call a null failure signature a repeat", () => {
    const prev = obs({ failureSignature: null });
    expect(deriveProgress(obs({ failureSignature: null }), prev).repeatedFailure).toBe(false);
  });

  it("reports findings present in both iterations", () => {
    const prev = obs({ findingSignatures: ["f1", "f2"] });
    const s = deriveProgress(obs({ findingSignatures: ["f2", "f3"] }), prev);
    expect(s.recurringFindings).toEqual(["f2"]);
  });

  it("computes cost burn rate as the per-iteration cost delta", () => {
    const prev = obs({ cumulativeCostUsd: 1.0 });
    const s = deriveProgress(obs({ cumulativeCostUsd: 1.7 }), prev);
    expect(s.costBurnRateUsd).toBeCloseTo(0.7);
  });
});
