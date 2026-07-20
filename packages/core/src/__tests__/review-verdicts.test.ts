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

  // Regression (real run): the verify LLM reproduces file:line exactly but
  // REFORMATS the claim (adds backticks, changes spacing). A unique candidate at
  // that location must still match — otherwise the whole strict review fails.
  it("matches a verdict whose claim was reformatted (backticks/spacing) at a unique location", () => {
    const cands = [
      cand(
        "major",
        "src/a.ts",
        "268",
        "The new hash short-circuit returns {success:true,skipped:true} on a cache hit"
      ),
    ];
    const text =
      "CONFIRMED major | src/a.ts:268 | The new hash short-circuit returns `{success:true, skipped:true}` on a cache hit | still short-circuits";
    const out = parseReviewVerdicts(text, cands);
    expect(out.errors).toEqual([]);
    expect(out.confirmed.map((f) => f.claim)).toEqual([
      "The new hash short-circuit returns {success:true,skipped:true} on a cache hit",
    ]);
  });

  it("keeps the severity check even when the claim was reformatted", () => {
    const cands = [
      cand("major", "src/a.ts", "268", "returns {success:true,skipped:true}"),
    ];
    const out = parseReviewVerdicts(
      "CONFIRMED nit | src/a.ts:268 | returns `{success:true, skipped:true}` | w",
      cands
    );
    expect(out.errors.some((e) => /severity/i.test(e))).toBe(true);
  });

  it("disambiguates two candidates at the same location by claim (no cross-match)", () => {
    const cands = [
      cand("major", "src/a.ts", "268", "null dereference on user path"),
      cand("minor", "src/a.ts", "268", "unused import of foo helper"),
    ];
    const text = [
      "REJECTED | src/a.ts:268 | unused import of foo helper | actually used",
      "CONFIRMED major | src/a.ts:268 | null dereference on user path | can be null",
    ].join("\n");
    const out = parseReviewVerdicts(text, cands);
    expect(out.errors).toEqual([]);
    expect(out.confirmed.map((f) => f.claim)).toEqual([
      "null dereference on user path",
    ]);
    expect(out.rejected.map((f) => f.claim)).toEqual([
      "unused import of foo helper",
    ]);
  });

  it("disambiguates two co-located candidates even when both claims are reformatted", () => {
    const cands = [
      cand("major", "src/a.ts", "268", "returns {success:true,skipped:true}"),
      cand("minor", "src/a.ts", "268", "logger.debug left in hot path"),
    ];
    const text = [
      "CONFIRMED major | src/a.ts:268 | returns `{success:true, skipped:true}` | confirmed",
      "REJECTED | src/a.ts:268 | `logger.debug` left in hot path | fine",
    ].join("\n");
    const out = parseReviewVerdicts(text, cands);
    expect(out.errors).toEqual([]);
    expect(out.confirmed.map((f) => f.severity)).toEqual(["major"]);
    expect(out.rejected.map((f) => f.claim)).toEqual([
      "logger.debug left in hot path",
    ]);
  });
});
