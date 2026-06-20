import { describe, expect, it } from "vitest";

import { parsePlanProgress } from "../plan-progress.js";

describe("parsePlanProgress", () => {
  it("returns empty result for empty string", () => {
    expect(parsePlanProgress("")).toEqual({ checked: 0, total: 0, items: [] });
  });

  it("returns empty result for garbage input", () => {
    expect(parsePlanProgress("not a checklist at all\n\njust text")).toEqual({
      checked: 0,
      total: 0,
      items: [],
    });
  });

  it("never throws on any input and returns zero-state", () => {
    const zero = { checked: 0, total: 0, items: [] };
    expect(() => parsePlanProgress(null as unknown as string)).not.toThrow();
    expect(parsePlanProgress(null as unknown as string)).toEqual(zero);
    expect(() => parsePlanProgress(undefined as unknown as string)).not.toThrow();
    expect(parsePlanProgress(undefined as unknown as string)).toEqual(zero);
    expect(() => parsePlanProgress("   ")).not.toThrow();
  });

  it("successive calls on the same input return independent results", () => {
    const md = "- [x] task one\n- [ ] task two";
    const first = parsePlanProgress(md);
    const second = parsePlanProgress(md);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.items).not.toBe(second.items);
  });

  it("counts a single unchecked item", () => {
    const result = parsePlanProgress("- [ ] do the thing");
    expect(result).toEqual({
      checked: 0,
      total: 1,
      items: [{ text: "do the thing", done: false }],
    });
  });

  it("counts a single checked item (lowercase x)", () => {
    const result = parsePlanProgress("- [x] done thing");
    expect(result).toEqual({
      checked: 1,
      total: 1,
      items: [{ text: "done thing", done: true }],
    });
  });

  it("counts a single checked item (uppercase X)", () => {
    const result = parsePlanProgress("- [X] done thing uppercase");
    expect(result).toEqual({
      checked: 1,
      total: 1,
      items: [{ text: "done thing uppercase", done: true }],
    });
  });

  it("handles mixed checked and unchecked items", () => {
    const md = `
- [x] first done
- [ ] second todo
- [X] third done
- [ ] fourth todo
`.trim();
    const result = parsePlanProgress(md);
    expect(result.total).toBe(4);
    expect(result.checked).toBe(2);
    expect(result.items).toEqual([
      { text: "first done", done: true },
      { text: "second todo", done: false },
      { text: "third done", done: true },
      { text: "fourth todo", done: false },
    ]);
  });

  it("handles asterisk bullet syntax", () => {
    const md = "* [x] asterisk done\n* [ ] asterisk todo";
    const result = parsePlanProgress(md);
    expect(result.total).toBe(2);
    expect(result.checked).toBe(1);
  });

  it("handles indented checkboxes", () => {
    const md = "  - [x] indented done\n  - [ ] indented todo";
    const result = parsePlanProgress(md);
    expect(result.total).toBe(2);
    expect(result.checked).toBe(1);
    expect(result.items[0]).toEqual({ text: "indented done", done: true });
  });

  it("does NOT count [ ] appearing mid-sentence", () => {
    const md =
      "This is some text with [ ] a checkbox in the middle of a sentence.";
    const result = parsePlanProgress(md);
    expect(result).toEqual({ checked: 0, total: 0, items: [] });
  });

  it("does not count mid-sentence checkboxes mixed with real list items", () => {
    const md = [
      "Some text with [ ] mid-sentence checkbox.",
      "- [x] real task",
      "Another line with [x] inline marker.",
    ].join("\n");
    const result = parsePlanProgress(md);
    expect(result.total).toBe(1);
    expect(result.checked).toBe(1);
  });

  it("trims trailing whitespace from item text", () => {
    const result = parsePlanProgress("- [ ] trailing spaces   ");
    expect(result.items[0].text).toBe("trailing spaces");
  });

  it("handles all-checked list", () => {
    const md = "- [x] a\n- [X] b\n- [x] c";
    const result = parsePlanProgress(md);
    expect(result.total).toBe(3);
    expect(result.checked).toBe(3);
  });

  it("handles all-unchecked list", () => {
    const md = "- [ ] a\n- [ ] b";
    const result = parsePlanProgress(md);
    expect(result.total).toBe(2);
    expect(result.checked).toBe(0);
  });

  it("captures text remainder correctly with trailing content", () => {
    const result = parsePlanProgress("- [x] implement the feature and tests");
    expect(result.items[0].text).toBe("implement the feature and tests");
  });
});
