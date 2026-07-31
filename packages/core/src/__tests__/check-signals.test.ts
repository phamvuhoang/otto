import { describe, expect, it } from "vitest";
import { checkSignals, nextFailureStreak } from "../progress.js";
import type { ChecksRecord } from "../checks.js";

const rec = (over: Partial<ChecksRecord>): ChecksRecord => ({
  command: "pnpm -r test",
  exitCode: 0,
  durationMs: 1200,
  outputTail: "",
  failureSignature: null,
  attestedAt: "2026-07-31T00:00:00.000Z",
  ...over,
});

describe("checkSignals", () => {
  it("stays null/null when checks were not measured", () => {
    // The inert case: no `checks` config ⇒ no records ⇒ today's behavior, where
    // deriveProgress leaves checksDelta null and decide sees nothing.
    expect(checkSignals(null)).toEqual({
      failingChecks: null,
      failureSignature: null,
    });
    expect(checkSignals(undefined)).toEqual({
      failingChecks: null,
      failureSignature: null,
    });
    expect(checkSignals([])).toEqual({
      failingChecks: null,
      failureSignature: null,
    });
  });

  it("reports zero failing and no signature when everything passed", () => {
    expect(checkSignals([rec({}), rec({})])).toEqual({
      failingChecks: 0,
      failureSignature: null,
    });
  });

  it("counts failures and surfaces the first failure signature", () => {
    const s = checkSignals([
      rec({}),
      rec({ exitCode: 1, failureSignature: "FAIL src/a.test.ts > adds" }),
      rec({ exitCode: 2, failureSignature: "error TS2304" }),
    ]);
    expect(s.failingChecks).toBe(2);
    expect(s.failureSignature).toBe("FAIL src/a.test.ts > adds");
  });

  it("falls back to the exit code when a failed record has no signature", () => {
    expect(checkSignals([rec({ exitCode: 3 })]).failureSignature).toBe(
      "exit 3"
    );
  });
});

describe("nextFailureStreak", () => {
  it("resets to 0 when the current iteration is green", () => {
    expect(nextFailureStreak("FAIL a", null, 4)).toBe(0);
  });

  it("starts at 1 on a newly seen failure", () => {
    expect(nextFailureStreak(null, "FAIL a", 0)).toBe(1);
  });

  it("increments while the same failure recurs", () => {
    expect(nextFailureStreak("FAIL a", "FAIL a", 1)).toBe(2);
    expect(nextFailureStreak("FAIL a", "FAIL a", 2)).toBe(3);
  });

  it("restarts at 1 when the failure changes", () => {
    // A different defect is not a repeat of the previous one — escalating on it
    // would blame a fresh failure for the old one's streak.
    expect(nextFailureStreak("FAIL a", "FAIL b", 3)).toBe(1);
  });
});
