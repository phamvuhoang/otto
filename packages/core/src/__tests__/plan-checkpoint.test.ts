import { describe, expect, it } from "vitest";

import {
  formatCheckpointPrompt,
  parseCheckpointResponse,
  resolvePlanCheckpoint,
} from "../plan-checkpoint.js";
import { scorePlanQuality } from "../plan-rubric.js";

const score = scorePlanQuality("## Problem\nx\n## Scope guard\nNon-goals: y");

describe("parseCheckpointResponse", () => {
  it("approves on y/yes/a/approve (case-insensitive, trimmed)", () => {
    for (const r of ["y", "Y", " yes ", "approve", "A"]) {
      expect(parseCheckpointResponse(r)).toBe("approve");
    }
  });
  it("edits on e/edit", () => {
    expect(parseCheckpointResponse("e")).toBe("edit");
    expect(parseCheckpointResponse("EDIT")).toBe("edit");
  });
  it("rejects on empty / n / no / anything ambiguous (safe default)", () => {
    for (const r of ["", "  ", "n", "no", "maybe", "later"]) {
      expect(parseCheckpointResponse(r)).toBe("reject");
    }
  });
});

describe("formatCheckpointPrompt", () => {
  it("renders the task key, scorecard, plan path, and the question", () => {
    const out = formatCheckpointPrompt({
      taskKey: "issue-63",
      planPath: ".otto/tasks/issue-63/plan.md",
      score,
    });
    expect(out).toContain("Plan checkpoint — issue-63");
    expect(out).toMatch(/plan quality:/i);
    expect(out).toContain(".otto/tasks/issue-63/plan.md");
    expect(out).toMatch(/\[y\]es \/ \[e\]dit \/ \[N\]o/);
  });
});

describe("resolvePlanCheckpoint", () => {
  function deps(interactive: boolean, line = "") {
    const lines: string[] = [];
    let read = 0;
    return {
      d: {
        interactive,
        readLine: async () => {
          read += 1;
          return line;
        },
        out: (m: string) => lines.push(m),
      },
      lines,
      reads: () => read,
    };
  }

  it("auto-approves and records the decision in a non-interactive run", async () => {
    const { d, lines, reads } = deps(false);
    expect(await resolvePlanCheckpoint("PROMPT", d)).toBe("approve");
    expect(reads()).toBe(0); // never reads stdin when non-interactive
    expect(lines.join("\n")).toMatch(/auto-approved/i);
  });

  it("reads and parses the operator's answer when interactive", async () => {
    expect(await resolvePlanCheckpoint("P", deps(true, "yes").d)).toBe("approve");
    expect(await resolvePlanCheckpoint("P", deps(true, "edit").d)).toBe("edit");
    expect(await resolvePlanCheckpoint("P", deps(true, "").d)).toBe("reject");
  });

  it("prints the prompt", async () => {
    const { d, lines } = deps(false);
    await resolvePlanCheckpoint("THE PROMPT", d);
    expect(lines[0]).toBe("THE PROMPT");
  });
});
