import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorktree, reapWorktrees } from "../worktree.js";

describe("createWorktree", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "otto-wt-"));
    const g = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    g("commit", "--allow-empty", "-qm", "root"); // ensure HEAD exists
    writeFileSync(join(repo, "f.txt"), "hi");
    g("add", ".");
    g("commit", "-qm", "init");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("creates an isolated worktree at HEAD and cleans it up", () => {
    const wt = createWorktree(repo, "t1");
    expect(existsSync(join(wt.dir, "f.txt"))).toBe(true);
    expect(wt.dir).toContain(join(".otto-tmp", "wt", "t1"));
    wt.cleanup();
    expect(existsSync(wt.dir)).toBe(false);
  });

  it("cleanup is idempotent", () => {
    const wt = createWorktree(repo, "t2");
    wt.cleanup();
    expect(() => wt.cleanup()).not.toThrow();
  });

  it("two worktrees are independent working directories", () => {
    const a = createWorktree(repo, "a");
    const b = createWorktree(repo, "b");
    writeFileSync(join(a.dir, "only-a.txt"), "x");
    expect(existsSync(join(a.dir, "only-a.txt"))).toBe(true);
    expect(existsSync(join(b.dir, "only-a.txt"))).toBe(false);
    a.cleanup();
    b.cleanup();
  });

  it("reapWorktrees removes the wt tree", () => {
    const wt = createWorktree(repo, "orphan");
    expect(existsSync(wt.dir)).toBe(true);
    reapWorktrees(repo);
    expect(existsSync(join(repo, ".otto-tmp", "wt"))).toBe(false);
  });
});
