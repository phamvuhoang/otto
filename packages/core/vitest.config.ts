import { defineConfig } from "vitest/config";

// Several suites exercise real filesystem, git subprocess, worktree, and
// advisory-lock (flock) work in temporary repositories. Under full-suite
// parallelism these occasionally exceed Vitest's 5s default and flake with a
// timeout even though they pass in isolation (contention, not logic). Raise the
// per-test and hook timeout headroom so contention no longer produces spurious
// failures. This changes only the timeout; test discovery and all other
// defaults are unchanged.
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
