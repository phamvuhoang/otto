import { describe, expect, it } from "vitest";

import {
  formatVerificationCoverageGate,
  formatVerificationMatrix,
  formatVisualEvidence,
  isValidArtifactReference,
  parseVerificationMatrix,
  parseVerificationMatrixWithDiagnostics,
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

describe("isValidArtifactReference", () => {
  it("accepts file:line, paths, and commit SHAs", () => {
    for (const ref of [
      "duration.test.ts:12",
      "src/cache.ts",
      ".otto-tmp/shots/after.png",
      "Makefile:3",
      "a1b2c3d",
      "0123456789abcdef0123456789abcdef01234567",
      "verification/x.png",
    ]) {
      expect(isValidArtifactReference(ref), ref).toBe(true);
    }
  });

  it("rejects bare commands, prose, placeholders, URLs, and traversal", () => {
    for (const ref of [
      "node --test",
      "read the code",
      "eyeballed a few values",
      "TODO",
      "see above",
      "",
      "   ",
      "https://example.com/proof.png",
      "http://x/y",
      "file:///etc/passwd",
      "../secret.txt",
      "../../etc/passwd",
      "src/../../escape.ts",
    ]) {
      expect(isValidArtifactReference(ref), ref).toBe(false);
    }
  });
});

describe("summarizeVerification", () => {
  it("does not count a bare command as an artifact (coverage stays 0)", () => {
    const s = summarizeVerification([
      { ...entry({}), artifactPath: "node --test" },
    ]);
    expect(s.withArtifact).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.verdict).toBe("unproven");
  });

  it("does not count an artifact the loop marked non-existent (artifactExists=false)", () => {
    const s = summarizeVerification([
      {
        ...entry({ artifactPath: "proof/missing.txt" }),
        artifactExists: false,
      },
    ]);
    expect(s.coverage).toBe(0);
    expect(s.verdict).toBe("unproven");
  });

  it("treats an all-deferred matrix as vacuously verified (deferred is exempt)", () => {
    const s = summarizeVerification([
      entry({ result: "deferred" }),
      entry({ result: "deferred" }),
    ]);
    expect(s.coverage).toBe(1);
    expect(s.verdict).toBe("verified");
  });

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
    // The actual check is shown, not hidden (#181 review).
    expect(out).toContain("node --test");
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

  it("fails and lists unproven + failed + incomplete requirements below the bar", () => {
    const g = scoreVerificationCoverage([
      entry({ requirement: "proven", artifactPath: "a.ts:1" }),
      entry({ requirement: "no-artifact", artifactPath: undefined }),
      entry({ requirement: "bare-cmd", artifactPath: "node --test" }),
      entry({ requirement: "broke", result: "fail" }),
      entry({ requirement: "half", result: "partial", artifactPath: "a.ts:9" }),
    ]);
    expect(g.passed).toBe(false);
    expect(g.unproven).toContain("no-artifact");
    // A bare command is not a valid artifact, so its requirement is unproven.
    expect(g.unproven).toContain("bare-cmd");
    expect(g.failed).toContain("broke");
    // An artifact-backed partial result is incomplete, not silently dropped.
    expect(g.incomplete).toContain("half");
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

  it("names incomplete (partial) requirements on FAIL", () => {
    const out = formatVerificationCoverageGate([
      entry({
        requirement: "half-done",
        result: "partial",
        artifactPath: "a.ts:1",
      }),
    ]);
    expect(out).toContain("FAIL");
    expect(out).toContain("half-done");
  });

  it("FAILs when malformed rows were dropped, even if surviving rows pass (#181 re-review)", () => {
    const g = scoreVerificationCoverage([entry({ artifactPath: "a.ts:1" })], 1);
    expect(g.passed).toBe(false);
    expect(g.dropped).toBe(1);
    const out = formatVerificationCoverageGate(
      [entry({ artifactPath: "a.ts:1" })],
      1
    );
    expect(out).toContain("Gate: **FAIL**");
    expect(out).toMatch(/dropped|malformed/i);
  });

  it("is empty for an empty matrix (nothing to gate)", () => {
    expect(formatVerificationCoverageGate([])).toBe("");
  });
});

describe("parseVerificationMatrixWithDiagnostics", () => {
  it("reports dropped malformed rows alongside the valid entries", () => {
    const raw = JSON.stringify([
      { requirement: "good", method: "test", check: "c", result: "pass" },
      { requirement: "bad", method: "nope", check: "c", result: "pass" },
      { method: "test", check: "c", result: "pass" }, // no requirement
    ]);
    const d = parseVerificationMatrixWithDiagnostics(raw);
    expect(d.parsed).toBe(true);
    expect(d.entries).toHaveLength(1);
    expect(d.dropped).toBe(2);
  });

  it("flags unparseable input", () => {
    const d = parseVerificationMatrixWithDiagnostics("not json");
    expect(d.parsed).toBe(false);
    expect(d.entries).toEqual([]);
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

  it("embeds a single bundle-relative screenshot as a markdown image", () => {
    const out = formatVisualEvidence([
      visual({
        requirement: "dashboard loads",
        artifactPath: "verification/0-dash.png",
      }),
    ]);
    expect(out).toMatch(/screenshot evidence/i);
    expect(out).toContain("dashboard loads");
    expect(out).toContain("![dashboard loads](verification/0-dash.png)");
  });

  it("renders a before/after pair when both are bundle-relative images", () => {
    const out = formatVisualEvidence([
      visual({
        beforePath: "verification/0-b.png",
        artifactPath: "verification/1-a.png",
      }),
    ]);
    expect(out).toContain("![before](verification/0-b.png)");
    expect(out).toContain("![after](verification/1-a.png)");
  });

  it("never embeds an invalid (URL / unrelocated / non-existent) artifact (#181 boundary review)", () => {
    // A URL beacon, an unrelocated repo path, and a loop-rejected artifact.
    expect(
      formatVisualEvidence([
        visual({ artifactPath: "https://attacker.example/beacon.png" }),
        visual({ artifactPath: "shots/not-relocated.png" }),
        visual({
          artifactPath: "verification/0.png",
          artifactExists: false,
        }),
      ])
    ).toBe("");
  });

  it("drops an invalid before reference but still embeds a valid after image", () => {
    const out = formatVisualEvidence([
      visual({
        beforePath: "https://attacker.example/x.png",
        artifactPath: "verification/1-a.png",
      }),
    ]);
    expect(out).not.toContain("attacker.example");
    expect(out).toContain("![");
    expect(out).toContain("verification/1-a.png");
  });

  it("is empty when there are no embeddable visual entries", () => {
    expect(
      formatVisualEvidence([
        { ...visual({}), method: "test", artifactPath: "x.test.ts:1" },
        visual({ artifactPath: undefined, confidence: "low" }),
      ])
    ).toBe("");
  });
});
