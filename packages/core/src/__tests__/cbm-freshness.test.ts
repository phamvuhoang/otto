import { describe, it, expect } from "vitest";
import {
  classifyIndexFreshness,
  diffWriteInventory,
  type CbmIndexIdentity,
} from "../codebase-memory-adapter.js";

const idx: CbmIndexIdentity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexStatus: "ready",
  indexedAt: "2026-07-04T00:00:00Z",
};

describe("classifyIndexFreshness", () => {
  it("absent when no index", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: false },
        null
      )
    ).toBe("absent");
  });
  it("wrong-project on workspace mismatch", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/other", sourceRevision: "abc123", worktreeDirty: false },
        idx
      )
    ).toBe("wrong-project");
  });
  it("stale on revision drift", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "def456", worktreeDirty: false },
        idx
      )
    ).toBe("stale");
  });
  it("stale when worktree dirty", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: true },
        idx
      )
    ).toBe("stale");
  });
  it("fresh when identity matches and clean", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: false },
        idx
      )
    ).toBe("fresh");
  });
});

describe("diffWriteInventory", () => {
  it("flags a write outside the declared cache", () => {
    const inv = diffWriteInventory(
      [".codebase-memory/a"],
      [".codebase-memory/a", ".codebase-memory/graph.db.zst", ".gitattributes"],
      [".codebase-memory"]
    );
    expect(inv.files).toEqual([
      ".codebase-memory/graph.db.zst",
      ".gitattributes",
    ]);
    expect(inv.escaped).toEqual([".gitattributes"]);
  });
  it("passes when all writes stay inside the cache", () => {
    const inv = diffWriteInventory(
      [],
      [".codebase-memory/graph.db.zst"],
      [".codebase-memory"]
    );
    expect(inv.escaped).toEqual([]);
  });
});
