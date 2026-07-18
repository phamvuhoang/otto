import { describe, it, expect } from "vitest";
import { authorizeToolOperation } from "../tools.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import { codebaseMemoryToolDefinition } from "../codebase-memory-adapter.js";

/**
 * Regression guard for the P26 slice2 write-root mismatch: the loop indexes
 * into the Otto-owned scratch dir `.otto/cbm-scratch`, so the stock
 * `codebaseMemoryToolDefinition()` must declare that same root — otherwise
 * `authorizeToolOperation` denies every index write and the feature is inert
 * even when enabled. Uses the real factory (not a hand-built tool) so a
 * future edit to the declared `writeRoots` trips this test instead of
 * silently reintroducing the mismatch.
 */
describe("codebase-memory index authorization (writeRoots regression)", () => {
  const config = {
    overrides: {
      "codebase-memory": { enabled: true, stages: ["plan"] },
    },
  };

  it("authorizes an index write confined to the declared .otto/cbm-scratch root", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      codebaseMemoryToolDefinition(),
      config,
      "plan",
      "index_repository",
      { writePaths: [".otto/cbm-scratch/graph.db.zst"] }
    );
    expect(a.allowed).toBe(true);
  });

  it("denies an index write against the old .codebase-memory root", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      codebaseMemoryToolDefinition(),
      config,
      "plan",
      "index_repository",
      { writePaths: [".codebase-memory/graph.db.zst"] }
    );
    expect(a.allowed).toBe(false);
  });
});
