import { canRetry } from "./shared.js";

/**
 * Uses the sync pipeline's retry policy (defined in `a.ts`, re-exported here
 * as `canRetry` via `./shared.ts`). Changing `MAX_RETRIES`/`shouldRetry` in
 * `a.ts` changes this function's behavior even though this file never
 * imports `a.ts` directly.
 */
export function syncWithBackoff(attempt: number): string {
  return canRetry(attempt) ? "retry" : "give up";
}
