import { describe, expect, it } from "vitest";
import { panelReadOnlyRefusal } from "../panel.js";

describe("panelReadOnlyRefusal", () => {
  it("refuses a tracked-dirty worktree under the restore policy", () => {
    const msg = panelReadOnlyRefusal(" M src/a.ts", "restore");
    expect(msg).not.toBeNull();
    expect(msg).toContain("uncommitted tracked changes");
    // Actionable: it must say what to DO, not just what is wrong.
    expect(msg).toMatch(/commit|stash/i);
  });

  it("allows a clean worktree", () => {
    expect(panelReadOnlyRefusal("", "restore")).toBeNull();
  });

  it("allows untracked-only dirt", () => {
    // trackedStatus ignores untracked files by design — a stray scratch file
    // cannot be clobbered by a reset, so it is not a reason to refuse.
    expect(panelReadOnlyRefusal("", "restore")).toBeNull();
  });

  it("does not refuse under the fail policy", () => {
    // Under `fail` any mutation is already a contract error, so read-only
    // enforcement was never disabled and there is nothing to refuse.
    expect(panelReadOnlyRefusal(" M src/a.ts", "fail")).toBeNull();
  });

  it("allows a non-repo (null status) rather than refusing", () => {
    // No git repo ⇒ nothing to protect and nothing to reset.
    expect(panelReadOnlyRefusal(null, "restore")).toBeNull();
  });
});
