import { describe, it, expect } from "vitest";
import { nextActionFor } from "../next-action.js";
import { CHECKS_FAILED_REASON, finalExitReason } from "../attestation.js";

describe("terminal-red exit reason", () => {
  it("overrides a success reason", () => {
    expect(finalExitReason("complete", CHECKS_FAILED_REASON)).toBe(
      CHECKS_FAILED_REASON
    );
    expect(finalExitReason("done", CHECKS_FAILED_REASON)).toBe(
      CHECKS_FAILED_REASON
    );
  });

  it("never masks a more informative failure reason", () => {
    expect(finalExitReason("stopped (budget)", CHECKS_FAILED_REASON)).toBe(
      "stopped (budget)"
    );
    expect(finalExitReason("halted (rate limit)", CHECKS_FAILED_REASON)).toBe(
      "halted (rate limit)"
    );
    expect(finalExitReason("paused (needs human)", CHECKS_FAILED_REASON)).toBe(
      "paused (needs human)"
    );
  });

  it("leaves the reason alone when checks were green or inert", () => {
    expect(finalExitReason("complete", null)).toBe("complete");
    expect(finalExitReason("stopped (budget)", null)).toBe("stopped (budget)");
  });

  it("has a maintainer-facing next action", () => {
    const action = nextActionFor(CHECKS_FAILED_REASON);
    expect(action).toContain("otto-inspect");
    expect(action).not.toBe("re-run to resume"); // not the generic fallback
  });
});
