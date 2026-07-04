// Barrel re-export: downstream modules import retry policy from *here*, never
// from `./a.ts` directly. This is the buried link a naive "who imports a.ts?"
// search misses but a codebase-memory index (import-graph aware) should not.
export { shouldRetry as canRetry } from "./a.js";
