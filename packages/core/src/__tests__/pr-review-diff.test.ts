import { describe, expect, it } from "vitest";

import {
  mapFindingToDiff,
  mapFindingsToDiff,
  parseZeroContextDiff,
  type DiffLine,
} from "../pr-review-diff.js";
import type { Finding } from "../review-severity.js";

// ---------------------------------------------------------------------------
// Diff fixtures — byte-exact `git diff --unified=0 --no-ext-diff --binary
// --no-renames` output (three-dot), as produced by the review worktree.
// ---------------------------------------------------------------------------

const ADDED = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..2fe4df4
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 37ffcc5..abfbcd2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10 +10 @@
-const x = 1;
+const x = 2;
`;

const DELETED = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index d4e91f6..0000000
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-old1
-old2
-old3
`;

// Two hunks in one file. The second hunk header carries a section heading
// (`@@ ... @@ e`) that must be ignored, and a pure-addition hunk (old count 0).
const MULTI = `diff --git a/multi.ts b/multi.ts
index 9405325..a275277 100644
--- a/multi.ts
+++ b/multi.ts
@@ -2 +2 @@ a
-b
+B2
@@ -5,0 +6,2 @@ e
+f
+g
`;

// core.quotePath=false renders a space/non-ASCII path literally; git then adds a
// trailing TAB to the ---/+++ lines to disambiguate the path from a timestamp.
const SPACED_PATH = "my dir/café ☕.ts";
const SPACED =
  `diff --git a/${SPACED_PATH} b/${SPACED_PATH}\n` +
  `index 111aaa..222bbb 100644\n` +
  `--- a/${SPACED_PATH}\t\n` +
  `+++ b/${SPACED_PATH}\t\n` +
  `@@ -1 +1 @@\n` +
  `-alpha\n` +
  `+beta\n`;

// A GIT binary patch carries NO @@ hunks and NO +/- content rows — and its
// base85 payload lines can themselves begin with `+`/`-`, so a naive parser
// would forge phantom mappings. Nothing here is mappable.
const BINARY = `diff --git a/img.bin b/img.bin
index eaf36c1..d43e6e8 100644
GIT binary patch
literal 6
NcmZQzWMXDv1pojk01yBG
+not-a-real-added-line
-not-a-real-removed-line

literal 4
LcmZQzWMT#Y01f~L
`;

function finding(over: Partial<Finding> = {}): Finding {
  return {
    severity: "major",
    file: "src/app.ts",
    line: "10",
    claim: "off-by-one",
    why: "wrong bound",
    lens: "correctness",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// parseZeroContextDiff
// ---------------------------------------------------------------------------

describe("parseZeroContextDiff", () => {
  it("maps added lines to RIGHT with new-file line numbers", () => {
    const map = parseZeroContextDiff(ADDED);
    expect(map.get("new.ts")).toEqual<DiffLine[]>([
      { path: "new.ts", side: "RIGHT", line: 1 },
      { path: "new.ts", side: "RIGHT", line: 2 },
      { path: "new.ts", side: "RIGHT", line: 3 },
    ]);
  });

  it("maps a modified hunk to both the removed LEFT and added RIGHT lines", () => {
    const map = parseZeroContextDiff(MODIFIED);
    expect(map.get("src/app.ts")).toEqual<DiffLine[]>([
      { path: "src/app.ts", side: "LEFT", line: 10 },
      { path: "src/app.ts", side: "RIGHT", line: 10 },
    ]);
  });

  it("maps deleted-file lines to LEFT with old-file line numbers (dest is /dev/null)", () => {
    const map = parseZeroContextDiff(DELETED);
    expect(map.get("old.ts")).toEqual<DiffLine[]>([
      { path: "old.ts", side: "LEFT", line: 1 },
      { path: "old.ts", side: "LEFT", line: 2 },
      { path: "old.ts", side: "LEFT", line: 3 },
    ]);
  });

  it("computes independent line numbers across multiple hunks, ignoring section headings", () => {
    const map = parseZeroContextDiff(MULTI);
    expect(map.get("multi.ts")).toEqual<DiffLine[]>([
      { path: "multi.ts", side: "LEFT", line: 2 },
      { path: "multi.ts", side: "RIGHT", line: 2 },
      { path: "multi.ts", side: "RIGHT", line: 6 },
      { path: "multi.ts", side: "RIGHT", line: 7 },
    ]);
  });

  it("parses a space/non-ASCII path, stripping the a//b/ prefix and trailing tab", () => {
    const map = parseZeroContextDiff(SPACED);
    expect(map.get(SPACED_PATH)).toEqual<DiffLine[]>([
      { path: SPACED_PATH, side: "LEFT", line: 1 },
      { path: SPACED_PATH, side: "RIGHT", line: 1 },
    ]);
  });

  it("records NO mappable lines for a binary patch (no phantom base85 rows)", () => {
    const map = parseZeroContextDiff(BINARY);
    expect(map.get("img.bin")).toBeUndefined();
  });

  it("parses a whole multi-file diff into one map keyed by path", () => {
    const combined = ADDED + MODIFIED + DELETED + BINARY;
    const map = parseZeroContextDiff(combined);
    expect([...map.keys()].sort()).toEqual(
      ["new.ts", "src/app.ts", "old.ts"].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// mapFindingToDiff
// ---------------------------------------------------------------------------

describe("mapFindingToDiff", () => {
  const map = parseZeroContextDiff(ADDED + MODIFIED + DELETED + MULTI + BINARY);

  it("maps a head-source finding to the RIGHT side (RIGHT wins over LEFT)", () => {
    const out = mapFindingToDiff(
      finding({ file: "src/app.ts", line: "10" }),
      map
    );
    expect(out.inlineEligible).toBe(true);
    expect(out.side).toBe("RIGHT");
    expect(out.mappedLine).toBe(10);
    // The original finding fields are preserved verbatim.
    expect(out.claim).toBe("off-by-one");
    expect(out.severity).toBe("major");
  });

  it("maps an added-file finding to RIGHT", () => {
    const out = mapFindingToDiff(finding({ file: "new.ts", line: "2" }), map);
    expect(out).toMatchObject({
      inlineEligible: true,
      side: "RIGHT",
      mappedLine: 2,
    });
  });

  it("maps a deleted-file finding to LEFT", () => {
    const out = mapFindingToDiff(finding({ file: "old.ts", line: "3" }), map);
    expect(out).toMatchObject({
      inlineEligible: true,
      side: "LEFT",
      mappedLine: 3,
    });
  });

  it("maps a numeric range to the FIRST mappable RIGHT line in ascending order", () => {
    const out = mapFindingToDiff(
      finding({ file: "multi.ts", line: "6-7" }),
      map
    );
    expect(out).toMatchObject({
      inlineEligible: true,
      side: "RIGHT",
      mappedLine: 6,
    });
  });

  it("normalizes a leading ./ or b/ on the finding path", () => {
    const a = mapFindingToDiff(
      finding({ file: "./src/app.ts", line: "10" }),
      map
    );
    const b = mapFindingToDiff(
      finding({ file: "b/src/app.ts", line: "10" }),
      map
    );
    expect(a).toMatchObject({
      inlineEligible: true,
      side: "RIGHT",
      mappedLine: 10,
    });
    expect(b).toMatchObject({
      inlineEligible: true,
      side: "RIGHT",
      mappedLine: 10,
    });
  });

  it("returns inlineEligible:false for a whole-file finding (no line)", () => {
    const out = mapFindingToDiff(
      finding({ file: "src/app.ts", line: undefined }),
      map
    );
    expect(out.inlineEligible).toBe(false);
    expect(out.side).toBeUndefined();
    expect(out.mappedLine).toBeUndefined();
  });

  it("returns inlineEligible:false for a line not present in the diff (no guessed line)", () => {
    const out = mapFindingToDiff(
      finding({ file: "src/app.ts", line: "999" }),
      map
    );
    expect(out.inlineEligible).toBe(false);
    expect(out.mappedLine).toBeUndefined();
  });

  it("returns inlineEligible:false for a binary-file finding", () => {
    const out = mapFindingToDiff(finding({ file: "img.bin", line: "1" }), map);
    expect(out.inlineEligible).toBe(false);
  });

  it("returns inlineEligible:false for a path outside the changed files", () => {
    const out = mapFindingToDiff(
      finding({ file: "unrelated.ts", line: "1" }),
      map
    );
    expect(out.inlineEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapFindingsToDiff
// ---------------------------------------------------------------------------

describe("mapFindingsToDiff", () => {
  it("never drops a finding and never guesses a line", () => {
    const findings: Finding[] = [
      finding({ file: "src/app.ts", line: "10" }), // mappable → RIGHT 10
      finding({ file: "img.bin", line: "1" }), // binary → body
      finding({ file: "src/app.ts", line: undefined }), // whole-file → body
      finding({ file: "elsewhere.ts", line: "5" }), // outside diff → body
    ];
    const out = mapFindingsToDiff(findings, MODIFIED + BINARY);
    // 1:1 — every confirmed finding survives.
    expect(out).toHaveLength(findings.length);
    expect(out[0]).toMatchObject({
      inlineEligible: true,
      side: "RIGHT",
      mappedLine: 10,
    });
    expect(out[1].inlineEligible).toBe(false);
    expect(out[2].inlineEligible).toBe(false);
    expect(out[3].inlineEligible).toBe(false);
    // No unmappable finding carries a placement.
    for (const f of out.filter((x) => !x.inlineEligible)) {
      expect(f.side).toBeUndefined();
      expect(f.mappedLine).toBeUndefined();
    }
  });
});
