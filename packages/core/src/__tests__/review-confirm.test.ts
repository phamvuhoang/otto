import { describe, expect, it } from "vitest";
import { parseConfirmation } from "../review-severity.js";

describe("parseConfirmation", () => {
  it("parses addressed and unaddressed rows", () => {
    const text = [
      "Looking at the synth commit against the confirmed list:",
      "",
      "ADDRESSED | src/a.ts:12 | unbounded loop can spin forever",
      "UNADDRESSED | src/b.ts:40 | missing null guard | the guard was added to the wrong branch",
      "",
      "<confirm>1 addressed, 1 unaddressed</confirm>",
    ].join("\n");
    const out = parseConfirmation(text);
    expect(out.addressed).toBe(1);
    expect(out.unaddressed).toEqual([
      {
        file: "src/b.ts:40",
        claim: "missing null guard",
        note: "the guard was added to the wrong branch",
      },
    ]);
  });

  it("treats a clean pass as fully addressed", () => {
    const out = parseConfirmation(
      "ADDRESSED | src/a.ts:1 | fixed\nADDRESSED | src/b.ts:2 | also fixed\n"
    );
    expect(out.addressed).toBe(2);
    expect(out.unaddressed).toEqual([]);
  });

  it("tolerates a missing note on an unaddressed row", () => {
    const out = parseConfirmation("UNADDRESSED | src/a.ts:1 | still broken");
    expect(out.unaddressed).toEqual([
      { file: "src/a.ts:1", claim: "still broken" },
    ]);
  });

  it("ignores prose and malformed rows rather than throwing", () => {
    const out = parseConfirmation(
      "I reviewed the diff.\nADDRESSED |\n| | |\nrandom text\nADDRESSED | src/a.ts:1 | ok"
    );
    expect(out.addressed).toBe(1);
    expect(out.unaddressed).toEqual([]);
  });

  it("returns an empty result for empty input", () => {
    expect(parseConfirmation("")).toEqual({ addressed: 0, unaddressed: [] });
  });

  it("is case-insensitive on the row marker", () => {
    const out = parseConfirmation("unaddressed | src/a.ts:1 | nope");
    expect(out.unaddressed).toHaveLength(1);
  });
});
