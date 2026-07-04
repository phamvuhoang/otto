import { describe, it, expect } from "vitest";
import {
  codebaseMemoryToolDefinition,
  type CbmRunner,
} from "../codebase-memory-adapter.js";

describe("codebaseMemoryToolDefinition", () => {
  it("declares no network, cache-only writes, and the op allowlist", () => {
    const t = codebaseMemoryToolDefinition("cbm");
    expect(t.kind).toBe("mcp");
    expect(t.networkDomains).toEqual([]);
    expect(t.writeRoots).toEqual([".codebase-memory"]);
    const names = (t.operations ?? []).map((o) => o.name);
    expect(names).toContain("index_repository");
    expect(names).toContain("search_graph");
    expect(names).not.toContain("delete_project");
    expect(
      t.operations?.find((o) => o.name === "index_repository")?.write
    ).toBe(true);
    expect(t.operations?.find((o) => o.name === "search_graph")?.write).toBe(
      false
    );
  });
});

describe("CbmRunner stub contract", () => {
  it("returns a structured response for an allowed op", () => {
    const stub: CbmRunner = {
      available: () => true,
      call: (req) => ({
        ok: true,
        result: { architecture: `for:${req.operation}` },
      }),
    };
    expect(stub.call({ operation: "get_architecture", params: {} }).ok).toBe(
      true
    );
  });
});
