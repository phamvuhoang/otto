// Alert dispatch. Duplicates its own backoff math instead of reusing the
// shared policy in policy.mjs -- the benchmark task fixes that duplication by
// renaming policy.mjs's `retryDelayMs` to `computeBackoffMs` and calling it
// from here, which is exactly the new caller edge the refreshed index needs
// to surface.
export function scheduleAlertRetry(attempt) {
  const delayMs = attempt * 200; // duplicated backoff math -- should call policy.mjs
  return { attempt, delayMs };
}
