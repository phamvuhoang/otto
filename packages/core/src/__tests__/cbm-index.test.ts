import { describe, it, expect } from "vitest";
import { runIndexRepository, type IndexInputs } from "../cbm-index.js";
import type { CbmRunner } from "../codebase-memory-adapter.js";

const okRunner: CbmRunner = {
  available: () => true,
  call: () => ({ ok: true, result: { status: "ready" } }),
};
const identity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexedAt: "2026-07-17T00:00:00Z",
};

function inputs(over: Partial<IndexInputs> = {}): IndexInputs {
  const files = [".otto/cbm-scratch/.codebase-memory/graph.db.zst"];
  return {
    runner: okRunner,
    scratchDir: ".otto/cbm-scratch",
    declaredRoots: [".otto/cbm-scratch"],
    // before: empty; after: only in-scratch writes
    snapshot: (() => {
      let n = 0;
      return () => (n++ === 0 ? [] : files);
    })(),
    identity,
    ...over,
  };
}

describe("runIndexRepository", () => {
  it("succeeds and records identity when all writes stay in scratch", () => {
    const r = runIndexRepository(inputs());
    expect(r.ok).toBe(true);
    expect(r.identity?.indexStatus).toBe("ready");
    expect(r.writeInventory.escaped).toEqual([]);
  });

  it("aborts when a write escapes the scratch dir", () => {
    const r = runIndexRepository(
      inputs({
        snapshot: (() => {
          let n = 0;
          return () => (n++ === 0 ? [] : [".gitattributes"]);
        })(),
      })
    );
    expect(r.ok).toBe(false);
    expect(r.fallbackReason).toMatch(/escap/i);
    expect(r.identity).toBeUndefined();
  });

  it("detects a workspace-root escape when watchDir spans the whole workspace (P26 slice2 fix)", () => {
    // Simulates the real production wiring: `snapshot` walks `watchDir` (the
    // workspace root), not `scratchDir`, so a write that lands outside the
    // declared scratch root — e.g. because the underlying tool ignored
    // `cacheDir` and wrote at cwd — is actually observed by the diff.
    const scratchFile = ".otto/cbm-scratch/.codebase-memory/graph.db.zst";
    const rootEscape = ".gitattributes";
    let call = 0;
    const seenDirs: string[] = [];
    const snapshot = (dir: string) => {
      seenDirs.push(dir);
      call++;
      // Both before/after snapshots walk watchDir; scratch-dir writes stay
      // inside declaredRoots, but the root escape only shows up in `after`.
      return call === 1 ? [] : [scratchFile, rootEscape];
    };
    const r = runIndexRepository(
      inputs({
        watchDir: "/repo",
        snapshot,
      })
    );
    // Proves the snapshot was called with watchDir, not scratchDir.
    expect(seenDirs).toEqual(["/repo", "/repo"]);
    expect(r.ok).toBe(false);
    expect(r.fallbackReason).toMatch(/escap/i);
    expect(r.writeInventory.escaped).toEqual([rootEscape]);
    expect(r.identity).toBeUndefined();
  });

  it("aborts when the runner call fails", () => {
    const r = runIndexRepository(
      inputs({
        runner: {
          available: () => true,
          call: () => ({ ok: false, error: "boom" }),
        },
      })
    );
    expect(r.ok).toBe(false);
    expect(r.fallbackReason).toMatch(/boom|index/i);
  });
});
