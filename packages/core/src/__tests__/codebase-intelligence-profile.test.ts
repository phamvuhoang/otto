import { describe, it, expect } from "vitest";
import { getProfile } from "../extension-profiles.js";

describe("codebase-intelligence profile", () => {
  it("ships the cbm tool with no network and cache-only writes", () => {
    const p = getProfile("codebase-intelligence");
    expect(p).toBeDefined();
    const tool = p!.tools.find((t) => t.name === "codebase-memory");
    expect(tool?.kind).toBe("mcp");
    expect(tool?.networkDomains).toEqual([]);
    expect(p!.policy?.allowedWriteRoots).toContain(".codebase-memory");
    expect(p!.requires).toContain("codebase-memory");
  });
});
