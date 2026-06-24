import { describe, expect, it } from "vitest";
import {
  dedupeFindings,
  parseFindings,
  rankFindings,
  severityCounts,
  suppressLowValue,
  type Finding,
} from "../review-severity.js";

describe("parseFindings", () => {
  it("parses pipe-delimited findings and tags the lens", () => {
    const text = [
      "Some prose the model wrote first.",
      "BLOCKER | src/loop.ts:120-180 | gate+routing+cost in one block | three responsibilities, hard to scan | extract resolveGate()",
      "nit | src/util.ts:4 | unused import | dead code |",
    ].join("\n");
    const { findings, dropped } = parseFindings(text, "structural");
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual<Finding>({
      severity: "blocker",
      file: "src/loop.ts",
      line: "120-180",
      claim: "gate+routing+cost in one block",
      why: "three responsibilities, hard to scan",
      suggestedFix: "extract resolveGate()",
      lens: "structural",
    });
    expect(findings[1].suggestedFix).toBeUndefined();
  });

  it("drops malformed lines instead of throwing", () => {
    const { findings, dropped } = parseFindings("MAYBE | only two fields");
    expect(findings).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});

describe("rankFindings", () => {
  it("orders blocker→major→minor→nit, stable within a tier", () => {
    const fs: Finding[] = [
      { severity: "nit", file: "a", claim: "a", why: "" },
      { severity: "blocker", file: "b", claim: "b", why: "" },
      { severity: "minor", file: "c", claim: "c", why: "" },
      { severity: "blocker", file: "d", claim: "d", why: "" },
    ];
    expect(rankFindings(fs).map((f) => f.file)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("suppressLowValue", () => {
  it("drops nits when a blocker or major exists", () => {
    const fs: Finding[] = [
      { severity: "blocker", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
      { severity: "nit", file: "c", claim: "c", why: "" },
    ];
    const { kept, suppressed } = suppressLowValue(fs);
    expect(kept.map((f) => f.severity)).toEqual(["blocker"]);
    expect(suppressed).toBe(2);
  });

  it("keeps everything when no blocker/major present", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
    ];
    const { kept, suppressed } = suppressLowValue(fs);
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });
});

describe("severityCounts", () => {
  it("tallies by severity and reports suppressed nits", () => {
    const fs: Finding[] = [
      { severity: "blocker", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
      { severity: "nit", file: "c", claim: "c", why: "" },
    ];
    const c = severityCounts(fs);
    expect(c.blocker).toBe(1);
    expect(c.nit).toBe(2);
    expect(c.suppressed).toBe(2); // both nits suppressed because a blocker exists
  });
});

describe("dedupeFindings", () => {
  it("merges same file+overlapping range, keeps highest severity, unions lenses", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "src/a.ts", line: "10-20", claim: "leaky", why: "w1", lens: "correctness" },
      { severity: "major", file: "src/a.ts", line: "15", claim: "leaky", why: "w2", lens: "structural" },
    ];
    const out = dedupeFindings(fs);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("major");
    expect(out[0].lens).toBe("correctness, structural");
    expect(out[0].why).toContain("w1");
    expect(out[0].why).toContain("w2");
  });

  it("keeps findings in different files or non-overlapping ranges separate", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "src/a.ts", line: "10", claim: "x", why: "" },
      { severity: "minor", file: "src/b.ts", line: "10", claim: "x", why: "" },
      { severity: "minor", file: "src/a.ts", line: "99", claim: "x", why: "" },
    ];
    expect(dedupeFindings(fs)).toHaveLength(3);
  });
});
