import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLearnings } from "../stage-exec.js";
import { LEARNINGS_FALLBACK, writeMemoryRecord } from "../memory.js";
import type { MemoryRecord } from "../memory.js";

const rec = (id: string, content: string): MemoryRecord => ({
  id,
  content,
  category: "convention",
  scope: [],
  confidence: 0.9,
  trust: "trusted",
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z",
  useCount: 1,
});

function ws(learnings?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-pl-"));
  if (learnings !== undefined) {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "LEARNINGS.md"), learnings, "utf8");
  }
  return dir;
}

describe("prepareLearnings", () => {
  it("returns the raw block for a small LEARNINGS.md", () => {
    const dir = ws("## Gotchas\n- pnpm not npm\n");
    try {
      expect(prepareLearnings({ workspaceDir: dir, env: {} }).text).toBe(
        "## Gotchas\n- pnpm not npm"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the exact fallback when the file is absent", () => {
    const dir = ws();
    try {
      expect(prepareLearnings({ workspaceDir: dir, env: {} }).text).toBe(
        LEARNINGS_FALLBACK
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds an over-budget file when governed records exist", () => {
    const dir = ws("q".repeat(7000));
    try {
      writeMemoryRecord(dir, rec("2026-07-01T00-00-00-000Z-a", "keep me"));
      const out = prepareLearnings({ workspaceDir: dir, env: {} });
      expect(out.text).toContain("keep me");
      expect(out.text).not.toContain("q".repeat(7000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors OTTO_UNBOUNDED_LEARNINGS as an escape hatch", () => {
    const dir = ws("q".repeat(7000));
    try {
      writeMemoryRecord(dir, rec("2026-07-01T00-00-00-000Z-a", "keep me"));
      const out = prepareLearnings({
        workspaceDir: dir,
        env: { OTTO_UNBOUNDED_LEARNINGS: "1" },
      });
      expect(out.text).toBe("q".repeat(7000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("threads the task key so same-task records rank highest", () => {
    const dir = ws("r".repeat(7000));
    try {
      writeMemoryRecord(dir, {
        ...rec("2026-07-01T00-00-00-000Z-a", "scoped to this task"),
        taskKey: "issue-42",
      });
      const out = prepareLearnings({
        workspaceDir: dir,
        taskKey: "issue-42",
        env: {},
      });
      expect(out.text).toContain("scoped to this task");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
