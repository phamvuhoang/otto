import { describe, expect, it } from "vitest";

import {
  formatVerificationCoverageGate,
  formatVerificationMatrix,
  formatVisualEvidence,
  parseVerificationMatrix,
  scoreVerificationCoverage,
  summarizeVerification,
  type VerificationEntry,
} from "../verification-matrix.js";

const entry = (over: Partial<VerificationEntry>): VerificationEntry => ({
  requirement: "does a thing",
  method: "test",
  check: "node --test",
  result: "pass",
  confidence: "high",
  ...over,
});

describe("summarizeVerification", () => {
  it("tallies results, artifact coverage, and an overall verdict", () => {
    const s = summarizeVerification([
      entry({ artifactPath: "a.test.ts:10" }),
      entry({ result: "pass", artifactPath: "b.ts:3" }),
      entry({ result: "deferred", confidence: "low" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.pass).toBe(2);
    expect(s.deferred).toBe(1);
    expect(s.fail).toBe(0);
    expect(s.withArtifact).toBe(2);
    // coverage = artifact-backed / verifiable (non-deferred) requirements.
    expect(s.coverage).toBeCloseTo(1, 5);
    // No failures, all verifiable requirements artifact-backed → verified.
    expect(s.verdict).toBe("verified");
  });

  it("verdicts as 'gaps' when any requirement failed", () => {
    const s = summarizeVerification([
      entry({}),
      entry({ result: "fail", confidence: "low" }),
    ]);
    expect(s.fail).toBe(1);
    expect(s.verdict).toBe("gaps");
  });

  it("verdicts as 'unproven' when verifiable requirements lack any artifact", () => {
    const s = summarizeVerification([
      entry({ artifactPath: undefined }),
      entry({ artifactPath: undefined }),
    ]);
    expect(s.withArtifact).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.verdict).toBe("unproven");
  });

  it("handles an empty matrix", () => {
    const s = summarizeVerification([]);
    expect(s.total).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.verdict).toBe("empty");
  });
});

describe("formatVerificationMatrix", () => {
  it("renders one row per requirement with its method, result, confidence and artifact", () => {
    const out = formatVerificationMatrix([
      entry({
        requirement: "totalMinutes handles hours",
        method: "test",
        check: "node --test",
        artifactPath: "duration.test.ts:12",
      }),
    ]);
    expect(out).toMatch(/verification/i);
    expect(out).toContain("totalMinutes handles hours");
    expect(out).toContain("duration.test.ts:12");
    expect(out).toContain("pass");
  });

  it("surfaces failures and unproven requirements as explicit risks, not buried", () => {
    const out = formatVerificationMatrix([
      entry({ requirement: "ok thing", artifactPath: "x.ts:1" }),
      entry({ requirement: "broken thing", result: "fail", confidence: "low" }),
      entry({ requirement: "unproven thing", artifactPath: undefined }),
    ]);
    expect(out.toLowerCase()).toContain("risk");
    expect(out).toContain("broken thing");
    expect(out).toContain("unproven thing");
  });

  it("notes when nothing was verified", () => {
    const out = formatVerificationMatrix([]);
    expect(out).toMatch(/no verification/i);
  });
});

describe("parseVerificationMatrix", () => {
  it("parses a valid matrix array, keeping known fields", () => {
    const raw = JSON.stringify([
      {
        requirement: "totalMinutes handles hours",
        method: "test",
        check: "node --test",
        artifactPath: "duration.test.ts:12",
        result: "pass",
        confidence: "high",
      },
    ]);
    const entries = parseVerificationMatrix(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].requirement).toBe("totalMinutes handles hours");
    expect(entries[0].artifactPath).toBe("duration.test.ts:12");
  });

  it("defaults a missing/invalid confidence to medium", () => {
    const raw = JSON.stringify([
      { requirement: "r", method: "command", check: "c", result: "pass" },
    ]);
    expect(parseVerificationMatrix(raw)[0].confidence).toBe("medium");
  });

  it("skips entries with an invalid method or result but keeps valid ones", () => {
    const raw = JSON.stringify([
      { requirement: "good", method: "test", check: "c", result: "pass" },
      { requirement: "bad-method", method: "wat", check: "c", result: "pass" },
      { requirement: "bad-result", method: "test", check: "c", result: "ok" },
      { requirement: "", method: "test", check: "c", result: "pass" },
    ]);
    const entries = parseVerificationMatrix(raw);
    expect(entries.map((e) => e.requirement)).toEqual(["good"]);
  });

  it("returns [] for malformed JSON or a non-array", () => {
    expect(parseVerificationMatrix("not json")).toEqual([]);
    expect(parseVerificationMatrix("{}")).toEqual([]);
    expect(parseVerificationMatrix("")).toEqual([]);
  });
});

describe("scoreVerificationCoverage", () => {
  it("passes when every verifiable requirement is artifact-backed and none failed", () => {
    const g = scoreVerificationCoverage([
      entry({ artifactPath: "a.ts:1" }),
      entry({ result: "deferred" }), // deferred is exempt from the bar
    ]);
    expect(g.passed).toBe(true);
    expect(g.coverage).toBeCloseTo(1, 5);
    expect(g.unproven).toEqual([]);
    expect(g.failed).toEqual([]);
  });

  it("fails and lists unproven + failed requirements below the bar", () => {
    const g = scoreVerificationCoverage([
      entry({ requirement: "proven", artifactPath: "a.ts:1" }),
      entry({ requirement: "no-artifact", artifactPath: undefined }),
      entry({ requirement: "broke", result: "fail" }),
    ]);
    expect(g.passed).toBe(false);
    expect(g.unproven).toContain("no-artifact");
    expect(g.failed).toContain("broke");
  });
});

describe("formatVerificationCoverageGate", () => {
  it("renders a PASS gate for a fully artifact-backed matrix", () => {
    const out = formatVerificationCoverageGate([
      entry({ artifactPath: "a:1" }),
    ]);
    expect(out).toMatch(/verification coverage/i);
    expect(out).toContain("PASS");
  });

  it("renders a FAIL gate naming the unproven requirements + a remediation", () => {
    const out = formatVerificationCoverageGate([
      entry({ requirement: "needs-proof", artifactPath: undefined }),
    ]);
    expect(out).toContain("FAIL");
    expect(out).toContain("needs-proof");
    // Tells the operator how to clear it.
    expect(out.toLowerCase()).toMatch(/artifact|deferred/);
  });

  it("is empty for an empty matrix (nothing to gate)", () => {
    expect(formatVerificationCoverageGate([])).toBe("");
  });
});

describe("parseVerificationMatrix — visual before/after", () => {
  it("keeps beforePath for a before/after visual entry", () => {
    const raw = JSON.stringify([
      {
        requirement: "settings page renders",
        method: "visual",
        check: "screenshot the rendered page",
        beforePath: ".otto-tmp/shots/before.png",
        artifactPath: ".otto-tmp/shots/after.png",
        result: "pass",
        confidence: "high",
      },
    ]);
    const e = parseVerificationMatrix(raw)[0];
    expect(e.beforePath).toBe(".otto-tmp/shots/before.png");
    expect(e.artifactPath).toBe(".otto-tmp/shots/after.png");
  });
});

describe("formatVisualEvidence", () => {
  const visual = (over: Partial<VerificationEntry>): VerificationEntry => ({
    requirement: "page renders",
    method: "visual",
    check: "screenshot",
    artifactPath: ".otto-tmp/shots/after.png",
    result: "pass",
    confidence: "high",
    ...over,
  });

  it("embeds a single screenshot as a markdown image under its requirement", () => {
    const out = formatVisualEvidence([
      visual({
        requirement: "dashboard loads",
        artifactPath: "shots/dash.png",
      }),
    ]);
    expect(out).toMatch(/screenshot evidence/i);
    expect(out).toContain("dashboard loads");
    expect(out).toContain("![dashboard loads](shots/dash.png)");
  });

  it("renders a before/after pair when beforePath is present", () => {
    const out = formatVisualEvidence([
      visual({ beforePath: "shots/b.png", artifactPath: "shots/a.png" }),
    ]);
    expect(out).toContain("![before](shots/b.png)");
    expect(out).toContain("![after](shots/a.png)");
  });

  it("is empty when there are no visual entries with a captured screenshot", () => {
    // A non-visual entry, and a visual one that could not be captured (no artifact).
    expect(
      formatVisualEvidence([
        { ...visual({}), method: "test", artifactPath: "x.test.ts:1" },
        visual({ artifactPath: undefined, confidence: "low" }),
      ])
    ).toBe("");
  });
});
