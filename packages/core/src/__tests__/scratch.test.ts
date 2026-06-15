import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanScratch } from "../scratch.js";

describe("cleanScratch", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "otto-scratch-"));
    roots.push(root);
    mkdirSync(join(root, ".otto-tmp"), { recursive: true });
    return root;
  }

  it("removes the ephemeral prompt, sandbox, spill, and panel entries", () => {
    const ws = makeWorkspace();
    const tmp = join(ws, ".otto-tmp");
    writeFileSync(join(tmp, ".run-123-1-456.md"), "prompt", "utf8");
    writeFileSync(join(tmp, ".sandbox-123-1-456.json"), "{}", "utf8");
    mkdirSync(join(tmp, "spill-123-1-implementer-456"));
    writeFileSync(join(tmp, "spill-123-1-implementer-456", "issue.json"), "{}");
    mkdirSync(join(tmp, "panel-123-1-456"));

    cleanScratch(ws);

    expect(existsSync(join(tmp, ".run-123-1-456.md"))).toBe(false);
    expect(existsSync(join(tmp, ".sandbox-123-1-456.json"))).toBe(false);
    expect(existsSync(join(tmp, "spill-123-1-implementer-456"))).toBe(false);
    expect(existsSync(join(tmp, "panel-123-1-456"))).toBe(false);
  });

  it("preserves persistent entries (logs, worktrees)", () => {
    const ws = makeWorkspace();
    const tmp = join(ws, ".otto-tmp");
    mkdirSync(join(tmp, "logs"));
    writeFileSync(join(tmp, "logs", "iter1.ndjson"), "{}", "utf8");
    writeFileSync(join(tmp, "logs", "detached-99.log"), "log", "utf8");
    mkdirSync(join(tmp, "worktrees"));
    writeFileSync(join(tmp, ".run-1-1-1.md"), "x", "utf8");

    cleanScratch(ws);

    expect(existsSync(join(tmp, "logs", "iter1.ndjson"))).toBe(true);
    expect(existsSync(join(tmp, "logs", "detached-99.log"))).toBe(true);
    expect(existsSync(join(tmp, "worktrees"))).toBe(true);
    expect(existsSync(join(tmp, ".run-1-1-1.md"))).toBe(false);
  });

  it("is a no-op when .otto-tmp does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "otto-scratch-"));
    roots.push(root);
    expect(() => cleanScratch(root)).not.toThrow();
  });
});
