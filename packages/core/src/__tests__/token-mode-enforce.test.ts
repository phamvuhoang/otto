import { describe, expect, it } from "vitest";
import { parseTokenMode } from "../tokens.js";

describe("parseTokenMode accepts the enforce tier", () => {
  it("parses every supported mode", () => {
    for (const m of ["off", "measure", "reduce", "enforce"] as const) {
      expect(parseTokenMode(m)).toBe(m);
    }
  });

  it("defaults to off for empty input", () => {
    expect(parseTokenMode(undefined)).toBe("off");
    expect(parseTokenMode("")).toBe("off");
  });

  it("names enforce in the error for an unknown mode", () => {
    // The message is how an operator discovers the tier exists.
    expect(() => parseTokenMode("bogus")).toThrow(/enforce/);
  });
});
