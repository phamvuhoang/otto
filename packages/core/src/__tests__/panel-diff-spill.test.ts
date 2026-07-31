import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spillHeadDiff } from "../panel.js";

function repoWithCommit(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-diff-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), body, "utf8");
  run("add", "a.txt");
  run("commit", "-qm", "add a");
  return dir;
}

describe("spillHeadDiff", () => {
  it("writes the HEAD patch once and returns its path", () => {
    const ws = repoWithCommit("hello spilled diff\n");
    const host = join(ws, ".otto-tmp", "panel-x");
    mkdirSync(host, { recursive: true });
    try {
      const p = spillHeadDiff(ws, host);
      expect(p).toBe(join(host, "head.diff"));
      const text = readFileSync(p, "utf8");
      expect(text).toContain("hello spilled diff");
      expect(text).toContain("a.txt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back rather than throwing when there is no HEAD", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-diff-"));
    execFileSync("git", ["init", "-q"], { cwd: ws, stdio: "pipe" });
    const host = join(ws, ".otto-tmp", "panel-x");
    mkdirSync(host, { recursive: true });
    try {
      const p = spillHeadDiff(ws, host);
      expect(readFileSync(p, "utf8")).toContain("No diff body");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("is written once and shared, not re-derived per lens", () => {
    // The whole point: N lenses read ONE file rather than each running
    // `git show HEAD` into its own spill dir.
    const ws = repoWithCommit("shared once\n");
    const host = join(ws, ".otto-tmp", "panel-x");
    mkdirSync(host, { recursive: true });
    try {
      const first = spillHeadDiff(ws, host);
      const before = readFileSync(first, "utf8");
      // A second lens does not re-spill; it is handed the same path.
      expect(spillHeadDiff(ws, host)).toBe(first);
      expect(readFileSync(first, "utf8")).toBe(before);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("review-lens.md consumes the shared spill", () => {
  const tpl = readFileSync(
    new URL("../../templates/review-lens.md", import.meta.url),
    "utf8"
  );

  it("references {{ DIFF_FILE }} instead of spilling per lens", () => {
    expect(tpl).toContain("{{ DIFF_FILE }}");
    expect(tpl).not.toContain("@spill?:head.diff=");
  });

  it("keeps the cheap inline --stat summary", () => {
    // The stat line is small and genuinely per-prompt useful; only the full
    // patch moved to the shared file.
    expect(tpl).toContain("!?`git show --stat HEAD");
  });
});
