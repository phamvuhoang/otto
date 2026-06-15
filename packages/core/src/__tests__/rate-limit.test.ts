import { describe, expect, it } from "vitest";
import {
  RateLimitError,
  computeWaitMs,
  isLimitResult,
  resetsAtFromEvent,
} from "../rate-limit.js";

describe("RateLimitError", () => {
  it("has name RateLimitError and carries resetsAt", () => {
    const e = new RateLimitError("limit", 1781517000);
    expect(e.name).toBe("RateLimitError");
    expect(e.resetsAt).toBe(1781517000);
    expect(e instanceof Error).toBe(true);
  });
});

describe("isLimitResult", () => {
  it("true when is_error and api_error_status 429", () => {
    expect(
      isLimitResult({
        result: "x",
        costUsd: 0,
        isError: true,
        apiErrorStatus: "429",
      })
    ).toBe(true);
  });
  it("true on the session-limit result text even without 429", () => {
    expect(
      isLimitResult({
        result: "You've hit your session limit · resets 4:50pm (Asia/Saigon)",
        costUsd: 0,
        isError: true,
        apiErrorStatus: null,
      })
    ).toBe(true);
  });
  it("false for a normal successful result", () => {
    expect(
      isLimitResult({
        result: "done",
        costUsd: 0.1,
        isError: false,
        apiErrorStatus: null,
      })
    ).toBe(false);
  });
  it("false for a non-limit error (e.g. 500)", () => {
    expect(
      isLimitResult({
        result: "boom",
        costUsd: 0,
        isError: true,
        apiErrorStatus: "500",
      })
    ).toBe(false);
  });
});

describe("resetsAtFromEvent", () => {
  it("extracts resetsAt from a rejected rate_limit_event", () => {
    const ev = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1781517000,
        rateLimitType: "five_hour",
      },
    };
    expect(resetsAtFromEvent(ev)).toBe(1781517000);
  });
  it("returns null when not a rate_limit_event or no resetsAt", () => {
    expect(resetsAtFromEvent({ type: "result" })).toBeNull();
    expect(
      resetsAtFromEvent({ type: "rate_limit_event", rate_limit_info: {} })
    ).toBeNull();
    expect(resetsAtFromEvent(null)).toBeNull();
  });
});

describe("computeWaitMs", () => {
  const now = 1_000_000_000_000; // ms
  it("waits until resetsAt plus buffer", () => {
    const resetsAt = Math.floor(now / 1000) + 600;
    expect(computeWaitMs(resetsAt, now, 30_000, 900_000)).toBe(
      600_000 + 30_000
    );
  });
  it("never negative when resetsAt already passed", () => {
    const resetsAt = Math.floor(now / 1000) - 600;
    expect(computeWaitMs(resetsAt, now, 30_000, 900_000)).toBe(0);
  });
  it("uses the fallback when resetsAt is null", () => {
    expect(computeWaitMs(null, now, 30_000, 900_000)).toBe(900_000);
  });
});
