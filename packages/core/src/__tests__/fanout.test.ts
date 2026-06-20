import { describe, expect, it } from "vitest";

import { runFanout } from "../fanout.js";
import type { PlanTask } from "../plan-tasks.js";

const t = (id: string, fileScope: string[], dependsOn: string[] = []): PlanTask => ({
  id,
  title: id,
  fileScope,
  dependsOn,
  parallelSafe: true,
});

const base = {
  workspaceDir: "/tmp/x",
  packageDir: "/tmp/pkg",
  iteration: 1,
  maxRetries: 0,
  cooldownMs: 0,
  concurrency: 2,
  ladder: { cheap: "haiku", mid: "sonnet", strong: "opus" },
  routing: true,
  runtimeId: "claude" as const,
};

describe("runFanout", () => {
  it("runs disjoint tasks in one wave and reports per-task outcomes", async () => {
    const started: string[] = [];
    const res = await runFanout({
      ...base,
      tasks: [t("t1", ["a.ts"]), t("t2", ["b.ts"])],
      runTask: async (task) => {
        started.push(task.id);
        return { ok: true };
      },
    });
    expect(started.sort()).toEqual(["t1", "t2"]);
    expect(res.outcomes.map((o) => o.status)).toEqual(["landed", "landed"]);
    expect(res.deferred).toEqual([]);
  });

  it("collects deferred tasks when a task does not land", async () => {
    const res = await runFanout({
      ...base,
      tasks: [t("t1", ["a.ts"]), t("t2", ["b.ts"])],
      runTask: async (task) =>
        task.id === "t2" ? { ok: false, reason: "conflict" } : { ok: true },
    });
    expect(res.deferred.map((x) => x.id)).toEqual(["t2"]);
    const t2 = res.outcomes.find((o) => o.task.id === "t2");
    expect(t2).toMatchObject({ status: "deferred", reason: "conflict" });
  });

  it("respects concurrency: never more than `concurrency` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await runFanout({
      ...base,
      concurrency: 2,
      tasks: [t("t1", ["a.ts"]), t("t2", ["b.ts"]), t("t3", ["c.ts"]), t("t4", ["d.ts"])],
      runTask: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true };
      },
    });
    expect(res.outcomes).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("throws when no runTask is provided (default wired in slice 7)", async () => {
    await expect(
      runFanout({ ...base, tasks: [t("t1", ["a.ts"])] })
    ).rejects.toThrow(/runTask/);
  });
});
