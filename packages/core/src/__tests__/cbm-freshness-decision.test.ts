import { describe, it, expect } from "vitest";
import { decideIndexAction, canInject } from "../cbm-index.js";
import type { CbmIndexIdentity } from "../codebase-memory-adapter.js";

const idx: CbmIndexIdentity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexStatus: "ready",
  indexedAt: "t",
};
const here = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
};

describe("decideIndexAction", () => {
  it("reuses a fresh index", () => {
    expect(decideIndexAction(here, idx)).toMatchObject({
      action: "reuse",
      freshness: "fresh",
    });
  });
  it("reindexes when absent", () => {
    expect(decideIndexAction(here, null)).toMatchObject({
      action: "reindex",
      freshness: "absent",
    });
  });
  it("reindexes on revision drift (stale)", () => {
    expect(
      decideIndexAction({ ...here, sourceRevision: "def" }, idx)
    ).toMatchObject({ action: "reindex", freshness: "stale" });
  });
});

describe("canInject", () => {
  it("allows injection only when fresh", () => {
    expect(canInject("fresh")).toEqual({ inject: true });
  });
  it("blocks injection with a reason otherwise", () => {
    expect(canInject("stale").inject).toBe(false);
    expect(canInject("stale").fallbackReason).toMatch(/stale/);
  });
});
