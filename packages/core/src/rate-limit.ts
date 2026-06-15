import type { StageResult } from "./runner.js";

/** Thrown when a stage hit a usage/session/rate limit. `resetsAt` is unix seconds
 *  (from the rate_limit_event) or null if the limit gave no reset time. */
export class RateLimitError extends Error {
  readonly resetsAt: number | null;
  constructor(message: string, resetsAt: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.resetsAt = resetsAt;
  }
}

/** True if a `result` event signals a usage/session/rate limit:
 *  is_error with an HTTP 429, or the CLI's "session limit" result text. */
export function isLimitResult(r: StageResult): boolean {
  if (!r.isError) return false;
  if (r.apiErrorStatus != null && /429/.test(r.apiErrorStatus)) return true;
  return /session limit|usage limit|rate.?limit/i.test(r.result);
}

/** resetsAt (unix seconds) from a `rate_limit_event`, else null. */
export function resetsAtFromEvent(ev: unknown): number | null {
  const e = (ev ?? {}) as Record<string, unknown>;
  if (e.type !== "rate_limit_event") return null;
  const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
  return typeof info.resetsAt === "number" ? info.resetsAt : null;
}

/** Milliseconds to wait before retrying. With a resetsAt: time until it + buffer
 *  (never negative). Without: the fallback. */
export function computeWaitMs(
  resetsAt: number | null,
  nowMs: number,
  bufferMs: number,
  fallbackMs: number
): number {
  if (resetsAt == null) return fallbackMs;
  return Math.max(0, resetsAt * 1000 - nowMs + bufferMs);
}
