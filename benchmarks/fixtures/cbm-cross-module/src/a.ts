/**
 * Retry policy for the sync pipeline. `src/b.ts` depends on this constant, but
 * only indirectly — through the `./shared.ts` barrel re-export — so a change
 * here does not show up in a naive grep for direct importers of `a.ts`.
 */
export const MAX_RETRIES = 3;

export function shouldRetry(attempt: number): boolean {
  return attempt < MAX_RETRIES;
}
