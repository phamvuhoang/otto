import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  git,
  hasUncommittedTrackedChanges,
  isGitRepo,
  isPathIgnored,
  refExists,
} from "../git.js";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "1");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("git helpers", () => {
  it("isGitRepo true in a repo, false outside", () => {
    const dir = tmpRepo();
    expect(isGitRepo(dir)).toBe(true);
    expect(isGitRepo(tmpdir())).toBe(false);
  });

  it("detects uncommitted tracked changes only", () => {
    const dir = tmpRepo();
    expect(hasUncommittedTrackedChanges(dir)).toBe(false);
    writeFileSync(join(dir, "untracked.txt"), "x"); // untracked → ignored
    expect(hasUncommittedTrackedChanges(dir)).toBe(false);
    writeFileSync(join(dir, "a.txt"), "2"); // tracked edit → dirty
    expect(hasUncommittedTrackedChanges(dir)).toBe(true);
  });

  it("isPathIgnored reflects .gitignore", () => {
    const dir = tmpRepo();
    expect(isPathIgnored(dir, ".otto-tmp")).toBe(false);
    writeFileSync(join(dir, ".gitignore"), ".otto-tmp\n");
    expect(isPathIgnored(dir, ".otto-tmp")).toBe(true);
  });

  it("refExists distinguishes existing from missing branches", () => {
    const dir = tmpRepo();
    expect(refExists(dir, "nope")).toBe(false);
    execFileSync("git", ["branch", "feature"], { cwd: dir });
    expect(refExists(dir, "feature")).toBe(true);
  });

  it("git() returns null on failure instead of throwing", () => {
    expect(git(["rev-parse", "HEAD"], tmpdir())).toBeNull();
  });
});
