import { describe, expect, it } from "vitest";
import { routedLenses, mergeLensFindings } from "../panel.js";

describe("routedLenses", () => {
  it("returns the full pool when the adaptive router is off", () => {
    const pool = ["correctness", "security", "tests", "task-fit", "structural"];
    expect(routedLenses(["src/loop.ts"], pool, false)).toEqual(pool);
  });
  it("drops structural for a docs-only change when routing is on", () => {
    const pool = ["correctness", "security", "tests", "task-fit", "structural"];
    expect(routedLenses(["README.md"], pool, true)).not.toContain("structural");
  });
});

describe("mergeLensFindings", () => {
  it("parses, tags lens, and dedupes across lens files", () => {
    const files = [
      { lens: "correctness", text: "minor | src/a.ts:10-20 | leaky | w1 |" },
      { lens: "structural", text: "major | src/a.ts:15 | leaky | w2 |" },
    ];
    const { findings, total } = mergeLensFindings(files);
    expect(total).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("major");
  });
});
