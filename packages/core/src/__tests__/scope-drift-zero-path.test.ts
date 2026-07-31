import { describe, expect, it } from "vitest";
import { detectScopeDrift } from "../plan-rubric.js";
import { summarizeScopeSentence } from "../report-finalize.js";

describe("detectScopeDrift on a plan that names no paths", () => {
  it("reports a coverage GAP, not total drift", () => {
    // A plan with no file map cannot tell us anything about scope. Flagging
    // every touched file as out-of-scope is a false verdict, not a cautious
    // one — it makes a clean run look like a runaway.
    const d = detectScopeDrift("# Plan\n\nDo the thing.", [
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(d.outOfScope).toEqual([]);
    expect(d.fileMapMissing).toBe(true);
    expect(d.touchedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("still detects real drift when the plan DOES name paths", () => {
    const d = detectScopeDrift("Files: `src/a.ts`", [
      "src/a.ts",
      "src/evil.ts",
    ]);
    expect(d.outOfScope).toEqual(["src/evil.ts"]);
    expect(d.fileMapMissing).toBeFalsy();
  });

  it("reports no drift when everything stayed in the map", () => {
    const d = detectScopeDrift("Files: `src/a.ts`", ["src/a.ts"]);
    expect(d.outOfScope).toEqual([]);
    expect(d.fileMapMissing).toBeFalsy();
  });
});

describe("report wording distinguishes a gap from clean scope", () => {
  it("says drift could not be assessed when the plan named no paths", () => {
    const s = summarizeScopeSentence({
      plannedFiles: [],
      touchedFiles: ["src/a.ts"],
      outOfScope: [],
      fileMapMissing: true,
    });
    expect(s).toMatch(/could not be assessed|coverage gap/i);
    expect(s).not.toMatch(/stayed inside/i);
  });

  it("says scope held when the plan named paths and nothing strayed", () => {
    const s = summarizeScopeSentence({
      plannedFiles: ["src/a.ts"],
      touchedFiles: ["src/a.ts"],
      outOfScope: [],
    });
    expect(s).toMatch(/stayed inside/i);
  });

  it("still flags real drift", () => {
    const s = summarizeScopeSentence({
      plannedFiles: ["src/a.ts"],
      touchedFiles: ["src/a.ts", "src/evil.ts"],
      outOfScope: ["src/evil.ts"],
    });
    expect(s).toMatch(/drift/i);
  });
});
