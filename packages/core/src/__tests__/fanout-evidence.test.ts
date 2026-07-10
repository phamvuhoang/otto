import { describe, it, expect } from "vitest";
import { summarizeFanout } from "../run-report.js";

const T = (id: string): any => ({
  id,
  title: id,
  fileScope: [],
  dependsOn: [],
  parallelSafe: true,
});

describe("summarizeFanout", () => {
  it("maps outcomes to contributions with status and reason", () => {
    const out = summarizeFanout({
      outcomes: [
        {
          task: T("t1"),
          status: "landed",
          handoff: {
            taskId: "t1",
            changedFiles: ["src/a.ts"],
            testsRun: [],
            risks: [],
            deferred: [],
            outOfScopeFiles: [],
          },
        },
        { task: T("t2"), status: "deferred", reason: "cherry-pick conflict" },
      ],
      deferred: [T("t2")],
      crossTaskSummary:
        "Cross-task interactions:\n- t2 deferred: cherry-pick conflict",
    } as any);
    expect(out.contributions).toHaveLength(2);
    expect(out.contributions[0]).toMatchObject({
      taskId: "t1",
      status: "landed",
      changedFiles: ["src/a.ts"],
    });
    expect(out.contributions[1]).toMatchObject({
      taskId: "t2",
      status: "deferred",
      reason: "cherry-pick conflict",
    });
    expect(out.crossTaskSummary).toContain("cherry-pick conflict");
  });
});
