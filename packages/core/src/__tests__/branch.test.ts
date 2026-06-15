import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirtyTreeWarning,
  ensureTmpIgnored,
  readBranchConfig,
  resolveBranch,
  slugify,
  writeBranchConfig,
} from "../branch.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "otto-cfg-"));
}

function tmpRepo2(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-rb-"));
  execFileSync("git", ["init", "-qb", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "1");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const base = (dir: string) => ({
  workspaceDir: dir,
  inputs: "plan-x.md",
  isTTY: false,
  now: () => "20260615-1200",
});

describe("slugify", () => {
  it("takes the basename of the first path token, drops extension", () => {
    expect(slugify("docs/2026-06-15-analytics.md other.md")).toBe(
      "2026-06-15-analytics"
    );
  });
  it("uses the first token's basename: lowercases, collapses non-alnum to dashes", () => {
    expect(slugify("docs/Add__Login!!.md other.md")).toBe("add-login");
  });
  it("caps length at 40 chars without trailing dash", () => {
    const s = slugify("a".repeat(60) + ".md");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("branch config", () => {
  it("returns empty object when .otto/config.json is absent", () => {
    expect(readBranchConfig(tmpDir())).toEqual({});
  });
  it("returns empty object on malformed JSON (never throws)", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".otto"));
    writeFileSync(join(dir, ".otto", "config.json"), "{ not json");
    expect(readBranchConfig(dir)).toEqual({});
  });
  it("round-trips a written config", () => {
    const dir = tmpDir();
    writeBranchConfig(dir, {
      branchStrategy: "worktree",
      branchPrefix: "otto/",
    });
    expect(readBranchConfig(dir)).toEqual({
      branchStrategy: "worktree",
      branchPrefix: "otto/",
    });
  });
  it("merges into an existing config, preserving unknown keys", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".otto"));
    writeFileSync(
      join(dir, ".otto", "config.json"),
      JSON.stringify({ extra: 1 })
    );
    writeBranchConfig(dir, { branchStrategy: "branch" });
    const raw = JSON.parse(
      readFileSync(join(dir, ".otto", "config.json"), "utf8")
    );
    expect(raw.extra).toBe(1);
    expect(raw.branchStrategy).toBe("branch");
  });
});

describe("resolveBranch", () => {
  it("defaults to current (no flag, no config, non-TTY)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("current");
    expect(r.branchName).toBeNull();
    expect(r.effectiveWorkspaceDir).toBe(dir);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("main");
  });

  it("flag wins over config", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "worktree" });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("otto/plan-x");
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("otto/plan-x");
  });

  it("config supplies the learned default", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "branch", branchPrefix: "bot/" });
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("bot/plan-x");
  });

  it("worktree mode returns a worktree dir under .otto-tmp/worktrees", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({ ...base(dir), flagStrategy: "worktree" });
    expect(r.strategy).toBe("worktree");
    expect(r.effectiveWorkspaceDir).toBe(
      join(dir, ".otto-tmp", "worktrees", "plan-x")
    );
    expect(existsSync(r.effectiveWorkspaceDir)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: r.effectiveWorkspaceDir,
      })
        .toString()
        .trim()
    ).toBe("otto/plan-x");
  });

  it("appends -2 on branch-name collision", async () => {
    const dir = tmpRepo2();
    execFileSync("git", ["branch", "otto/plan-x"], { cwd: dir });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.branchName).toBe("otto/plan-x-2");
  });

  it("falls back to a timestamp slug when inputs are empty (ghafk)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      inputs: "",
      flagStrategy: "branch",
    });
    expect(r.branchName).toBe("otto/20260615-1200");
  });

  it("errors for branch/worktree when not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-norepo-"));
    await expect(
      resolveBranch({ ...base(dir), flagStrategy: "branch" })
    ).rejects.toThrow(/git repo/i);
  });

  it("prompts when TTY and unresolved, and remembers on yes", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      isTTY: true,
      prompt: async () => ({ strategy: "branch" as const, remember: true }),
    });
    expect(r.strategy).toBe("branch");
    expect(readBranchConfig(dir).branchStrategy).toBe("branch");
  });
});

describe("ensureTmpIgnored", () => {
  it("adds .otto-tmp/ to .gitignore (creating the file) and is idempotent", () => {
    const dir = tmpRepo2();
    ensureTmpIgnored(dir);
    const after = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(after).toContain(".otto-tmp/");
    ensureTmpIgnored(dir); // second call must not duplicate
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(after);
  });
  it("does not duplicate when a .otto-tmp entry already exists", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, ".gitignore"), ".otto-tmp\n");
    ensureTmpIgnored(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".otto-tmp\n");
  });
  it("only adds .otto-tmp, never .otto itself", () => {
    const dir = tmpRepo2();
    ensureTmpIgnored(dir);
    const lines = readFileSync(join(dir, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).not.toContain(".otto");
    expect(lines).not.toContain(".otto/");
  });
  it("no-ops outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-nogit-"));
    expect(() => ensureTmpIgnored(dir)).not.toThrow();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});

describe("dirtyTreeWarning", () => {
  it("warns on a dirty tree for non-worktree strategies", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, "f.txt"), "changed");
    expect(dirtyTreeWarning(dir, "current")).toMatch(/uncommitted/);
    expect(dirtyTreeWarning(dir, "worktree")).toBeNull();
  });
  it("no warning on a clean tree", () => {
    expect(dirtyTreeWarning(tmpRepo2(), "current")).toBeNull();
  });
});
