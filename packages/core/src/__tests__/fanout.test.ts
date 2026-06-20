import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFanout, type RunFanoutOptions } from "../fanout.js";
import type { PlanTask } from "../plan-tasks.js";

const t = (id: string, fileScope: string[], dependsOn: string[] = []): PlanTask => ({
  id,
  title: id,
  fileScope,
  dependsOn,
  parallelSafe: true,
});

let repo: string;

const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "otto-fanout-"));
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  g("add", ".");
  g("commit", "-qm", "init");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Commit `content` to `file` inside a worktree dir, as a fake sub-agent would. */
function commitInWorktree(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", `work ${file}`], { cwd: dir, stdio: "ignore" });
}

function baseOpts(tasks: PlanTask[], runSubAgent: RunFanoutOptions["runSubAgent"]): RunFanoutOptions {
  return {
    tasks,
    workspaceDir: repo,
    packageDir: join(repo, "pkg"),
    iteration: 1,
    maxRetries: 0,
    cooldownMs: 0,
    concurrency: 2,
    ladder: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    routing: false,
    runtimeId: "claude",
    runSubAgent,
  };
}

/** True if the workspace worktree has a cherry-pick conflict / unmerged paths. */
function treeConflicted(): boolean {
  const s = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  return /^(UU|AA|DD|U[ADU]|[ADU]U)/m.test(s);
}

describe("runFanout (worktree merge)", () => {
  it("lands disjoint tasks: both commits cherry-pick cleanly onto HEAD", async () => {
    const res = await runFanout(
      baseOpts([t("t1", ["a.txt"]), t("t2", ["b.txt"])], async (task, dir) => {
        commitInWorktree(dir, task.id === "t1" ? "a.txt" : "b.txt", task.id);
      })
    );
    expect(res.outcomes.map((o) => o.status)).toEqual(["landed", "landed"]);
    expect(res.deferred).toEqual([]);
    // Both files present on the workspace HEAD, tree clean.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("t1");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("t2");
    expect(treeConflicted()).toBe(false);
  });

  it("defers a conflicting task and leaves the tree clean (not conflicted)", async () => {
    // Two tasks with DISJOINT declared scopes (so one concurrent wave off the
    // same base HEAD), but their sub-agents both stray onto the same real file
    // with divergent content — the under-declaration fan-out must survive. The
    // first cherry-picks clean; the second, based on the same parent, conflicts.
    const res = await runFanout(
      baseOpts([t("t1", ["a.txt"]), t("t2", ["b.txt"])], async (task, dir) => {
        commitInWorktree(dir, "shared.txt", `${task.id}-content\n`);
      })
    );
    const statuses = res.outcomes.map((o) => o.status).sort();
    expect(statuses).toEqual(["deferred", "landed"]);
    expect(res.deferred).toHaveLength(1);
    expect(res.outcomes.find((o) => o.status === "deferred")?.reason).toBe(
      "cherry-pick conflict"
    );
    expect(treeConflicted()).toBe(false); // conflict was aborted, not left in the tree
  });

  it("defers a task whose sub-agent made no commit", async () => {
    const res = await runFanout(
      baseOpts([t("t1", ["a.txt"])], async () => {
        /* no commit */
      })
    );
    expect(res.outcomes[0]).toMatchObject({ status: "deferred", reason: "no commit produced" });
  });

  it("defers a task whose sub-agent throws, tree stays clean", async () => {
    const res = await runFanout(
      baseOpts([t("t1", ["a.txt"])], async () => {
        throw new Error("boom");
      })
    );
    expect(res.outcomes[0].status).toBe("deferred");
    expect(res.outcomes[0].reason).toContain("boom");
    expect(treeConflicted()).toBe(false);
  });

  it("bounds concurrency to `concurrency` within a wave", async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await runFanout({
      ...baseOpts(
        [t("t1", ["a.txt"]), t("t2", ["b.txt"]), t("t3", ["c.txt"]), t("t4", ["d.txt"])],
        async (task, dir) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          commitInWorktree(dir, `${task.id}.txt`, task.id);
        }
      ),
      concurrency: 2,
    });
    expect(res.outcomes).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
