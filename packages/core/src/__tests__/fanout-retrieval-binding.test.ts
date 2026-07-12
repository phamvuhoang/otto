import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFanout, worktreeIndexIdentity } from "../fanout.js";
import type { PlanTask } from "../plan-tasks.js";

describe("worktreeIndexIdentity", () => {
  it("reports the worktree dir as workspace and the before-SHA as revision", () => {
    const id = worktreeIndexIdentity("/repo/.otto-tmp/wt/1-t1", "abc123");
    expect(id.workspace).toBe("/repo/.otto-tmp/wt/1-t1");
    expect(id.sourceRevision).toBe("abc123");
  });

  it("reports the worktree as clean (dirty tracking is a later concern)", () => {
    const id = worktreeIndexIdentity("/repo/.otto-tmp/wt/1-t1", "abc123");
    expect(id.worktreeDirty).toBe(false);
  });
});

describe("runFanout with retrievalStore/bindWorktreeIdentity (P25 Task 7 seam)", () => {
  let repo: string;
  const g = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "otto-fanout-bind-"));
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    g("add", ".");
    g("commit", "-qm", "init");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function commitInWorktree(dir: string, file: string, content: string): void {
    writeFileSync(join(dir, file), content);
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", `work ${file}`], {
      cwd: dir,
      stdio: "ignore",
    });
  }

  const t = (id: string, fileScope: string[]): PlanTask => ({
    id,
    title: id,
    fileScope,
    dependsOn: [],
    parallelSafe: true,
  });

  it("landing outcome is identical whether or not bindWorktreeIdentity/retrievalStore are set (inert by default)", async () => {
    const tasks = [t("t1", ["a.txt"]), t("t2", ["b.txt"])];
    const runSubAgent = async (task: PlanTask, dir: string) => {
      commitInWorktree(dir, task.id === "t1" ? "a.txt" : "b.txt", task.id);
    };
    const base = {
      tasks,
      workspaceDir: repo,
      packageDir: join(repo, "pkg"),
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      concurrency: 2,
      ladder: { cheap: "haiku", mid: "sonnet", strong: "opus" } as const,
      routing: false,
      runtimeId: "claude" as const,
      runSubAgent,
    };

    const withoutBinding = await runFanout(base);
    expect(withoutBinding.outcomes.map((o) => o.status)).toEqual([
      "landed",
      "landed",
    ]);

    // Reset the workspace to re-run the same scenario with binding on.
    g("reset", "--hard", "HEAD~2");

    const withBinding = await runFanout({
      ...base,
      bindWorktreeIdentity: true,
      retrievalStore: (key: string) => key,
    });
    expect(withBinding.outcomes.map((o) => o.status)).toEqual([
      "landed",
      "landed",
    ]);
  });
});
