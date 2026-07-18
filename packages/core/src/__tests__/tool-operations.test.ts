import { describe, it, expect } from "vitest";
import { authorizeToolOperation, type ToolDefinition } from "../tools.js";
import { DEFAULT_POLICY } from "../safety-policy.js";

const CBM: ToolDefinition = {
  name: "codebase-memory",
  kind: "mcp",
  description: "",
  capabilities: [],
  stages: ["plan", "reviewer"],
  env: [],
  networkDomains: [],
  writeRoots: [".otto/cbm-scratch"],
  secretRefs: [],
  approvalActions: [],
  enabled: true,
  operations: [
    { name: "index_repository", write: true },
    { name: "get_architecture", write: false },
    { name: "search_graph", write: false },
  ],
};
const CONFIG = { overrides: {} };

describe("authorizeToolOperation", () => {
  it("allows a declared read op on an enabled stage", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "search_graph",
      {}
    );
    expect(a.allowed).toBe(true);
    expect(a.violations).toEqual([]);
  });

  it("allows the single write op with in-scope write paths", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "index_repository",
      {
        writePaths: [".otto/cbm-scratch/graph.db.zst"],
      }
    );
    expect(a.allowed).toBe(true);
  });

  it("blocks an undeclared/excluded op and emits a policy-violation event", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "delete_project",
      {}
    );
    expect(a.allowed).toBe(false);
    expect(a.events.some((e) => e.category === "policy-violation")).toBe(true);
  });

  it("blocks any op on a stage the tool is not enabled for", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "implementer",
      "search_graph",
      {}
    );
    expect(a.allowed).toBe(false);
  });
});
