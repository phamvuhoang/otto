// Retry backoff policy for outbound calls. The benchmark task renames this
// symbol and wires a brand-new caller into alerts.mjs -- the reviewer stage
// must see the renamed symbol's new caller graph, which only a freshly
// refreshed codebase-memory index reflects. An index built before this edit
// still knows the old name (`retryDelayMs`) with its old, now-stale caller
// set (none), and would miss that `alerts.mjs` now depends on it.
export function retryDelayMs(attempt) {
  return attempt * 200;
}
