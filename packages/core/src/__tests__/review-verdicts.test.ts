import { describe, expect, it } from "vitest";
import {
  findingToWire,
  parseReviewVerdicts,
  type Finding,
} from "../review-severity.js";

const cand = (
  severity: Finding["severity"],
  file: string,
  line: string | undefined,
  claim: string
): Finding => ({ severity, file, line, claim, why: "orig why" });

describe("findingToWire", () => {
  it("serializes severity | file:line | claim | why with optional fix", () => {
    expect(
      findingToWire({
        severity: "major",
        file: "src/a.ts",
        line: "12",
        claim: "bug",
        why: "reason",
      })
    ).toBe("major | src/a.ts:12 | bug | reason");
    expect(
      findingToWire({
        severity: "nit",
        file: "src/a.ts",
        line: "12",
        claim: "bug",
        why: "reason",
        suggestedFix: "do x",
      })
    ).toBe("nit | src/a.ts:12 | bug | reason | do x");
  });
  it("omits the line segment when absent", () => {
    expect(
      findingToWire({
        severity: "minor",
        file: "src/a.ts",
        claim: "c",
        why: "w",
      })
    ).toBe("minor | src/a.ts | c | w");
  });
});

describe("parseReviewVerdicts", () => {
  it("maps confirmed and rejected rows back to candidates", () => {
    const cands = [
      cand("major", "src/a.ts", "12", "null dereference"),
      cand("minor", "src/b.ts", "9", "missing guard"),
    ];
    const text = [
      "CONFIRMED major | src/a.ts:12 | null dereference | branch can return null",
      "REJECTED | src/b.ts:9 | missing guard | caller already validates the value",
    ].join("\n");
    const out = parseReviewVerdicts(text, cands);
    expect(out.errors).toEqual([]);
    expect(out.confirmed.map((f) => f.claim)).toEqual(["null dereference"]);
    expect(out.rejected.map((f) => f.claim)).toEqual(["missing guard"]);
  });

  it("orders confirmed findings by severity (stable within tier)", () => {
    const cands = [
      cand("nit", "a.ts", "1", "n1"),
      cand("blocker", "a.ts", "2", "b1"),
      cand("major", "a.ts", "3", "m1"),
    ];
    const text = [
      "CONFIRMED nit | a.ts:1 | n1 | w",
      "CONFIRMED blocker | a.ts:2 | b1 | w",
      "CONFIRMED major | a.ts:3 | m1 | w",
    ].join("\n");
    const out = parseReviewVerdicts(text, cands);
    expect(out.errors).toEqual([]);
    expect(out.confirmed.map((f) => f.severity)).toEqual([
      "blocker",
      "major",
      "nit",
    ]);
  });

  it("handles CRLF line endings", () => {
    const cands = [cand("major", "a.ts", "1", "c1")];
    const out = parseReviewVerdicts(
      "CONFIRMED major | a.ts:1 | c1 | w\r\n",
      cands
    );
    expect(out.errors).toEqual([]);
    expect(out.confirmed).toHaveLength(1);
  });

  it("matches a verdict line inside a candidate's line range", () => {
    const cands = [cand("major", "a.ts", "10-20", "c1")];
    const out = parseReviewVerdicts(
      "CONFIRMED major | a.ts:12 | c1 | w",
      cands
    );
    expect(out.errors).toEqual([]);
    expect(out.confirmed).toHaveLength(1);
  });

  it("ignores the trailing tally line and accepts none for empty candidates", () => {
    const out = parseReviewVerdicts("none\n<verify>0 confirmed</verify>", []);
    expect(out.errors).toEqual([]);
    expect(out.confirmed).toEqual([]);
    expect(out.rejected).toEqual([]);
  });

  it("errors on `none` when candidates exist", () => {
    const out = parseReviewVerdicts("none", [cand("major", "a.ts", "1", "c1")]);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("errors on a duplicate verdict for the same candidate", () => {
    const cands = [cand("major", "a.ts", "1", "c1")];
    const out = parseReviewVerdicts(
      ["CONFIRMED major | a.ts:1 | c1 | w", "REJECTED | a.ts:1 | c1 | w"].join(
        "\n"
      ),
      cands
    );
    expect(out.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("errors on a verdict for an unknown candidate", () => {
    const cands = [cand("major", "a.ts", "1", "c1")];
    const out = parseReviewVerdicts(
      [
        "CONFIRMED major | a.ts:1 | c1 | w",
        "REJECTED | z.ts:9 | ghost | w",
      ].join("\n"),
      cands
    );
    expect(out.errors.some((e) => /unmatched/i.test(e))).toBe(true);
  });

  it("errors when a candidate receives no verdict", () => {
    const cands = [
      cand("major", "a.ts", "1", "c1"),
      cand("minor", "b.ts", "2", "c2"),
    ];
    const out = parseReviewVerdicts("CONFIRMED major | a.ts:1 | c1 | w", cands);
    expect(out.errors.some((e) => /missing/i.test(e))).toBe(true);
  });

  it("errors on a bad status token", () => {
    const cands = [cand("major", "a.ts", "1", "c1")];
    const out = parseReviewVerdicts("MAYBE major | a.ts:1 | c1 | w", cands);
    expect(out.errors.some((e) => /status/i.test(e))).toBe(true);
  });

  it("errors on a severity mismatch for a confirmed verdict", () => {
    const cands = [cand("major", "a.ts", "1", "c1")];
    const out = parseReviewVerdicts("CONFIRMED nit | a.ts:1 | c1 | w", cands);
    expect(out.errors.some((e) => /severity/i.test(e))).toBe(true);
  });
});
