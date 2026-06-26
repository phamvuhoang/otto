import { describe, expect, it } from "vitest";

import { reviewsFanoutInsteadOfReplan } from "../plan-fanout.js";

describe("reviewsFanoutInsteadOfReplan", () => {
  const base = {
    mode: "plan",
    fanOut: true,
    landed: 2,
    hasReviewStage: true,
  };

  it("is true when a --plan run's fan-out landed implementation work and a reviewer is available", () => {
    expect(reviewsFanoutInsteadOfReplan(base)).toBe(true);
  });

  it("is false when fan-out landed nothing — a genuine plan-authoring run", () => {
    expect(reviewsFanoutInsteadOfReplan({ ...base, landed: 0 })).toBe(false);
  });

  it("is false outside --plan mode — a normal fan-out implement run is unchanged", () => {
    expect(reviewsFanoutInsteadOfReplan({ ...base, mode: "afk" })).toBe(false);
  });

  it("is false when fan-out is off", () => {
    expect(reviewsFanoutInsteadOfReplan({ ...base, fanOut: false })).toBe(
      false
    );
  });

  it("is false when no reviewer stage is wired — cannot review, so fall back to the plan chain", () => {
    expect(
      reviewsFanoutInsteadOfReplan({ ...base, hasReviewStage: false })
    ).toBe(false);
  });
});
