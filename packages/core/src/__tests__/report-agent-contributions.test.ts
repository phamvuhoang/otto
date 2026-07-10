import { describe, it, expect } from "vitest";
import { formatAgentContributions } from "../report-finalize.js";

describe("formatAgentContributions", () => {
  it("lists each agent and every defer reason", () => {
    const md = formatAgentContributions({
      contributions: [
        { taskId: "t1", status: "landed", changedFiles: ["src/a.ts"] },
        {
          taskId: "t2",
          status: "deferred",
          changedFiles: [],
          reason: "cherry-pick conflict",
        },
      ],
      crossTaskSummary:
        "Cross-task interactions:\n- t2 deferred: cherry-pick conflict",
    });
    expect(md).toContain("t1");
    expect(md).toContain("landed");
    expect(md).toContain("cherry-pick conflict");
  });
  it("empty when no contributions", () => {
    expect(
      formatAgentContributions({ contributions: [], crossTaskSummary: "" })
    ).toBe("");
  });
});
