import { describe, expect, it } from "vitest";

import {
  analyzeContext,
  estimateTokens,
  formatContextReport,
  type ContextBreakdown,
} from "../context-report.js";

function charsOf(b: ContextBreakdown, category: string): number {
  return b.segments.find((s) => s.category === category)?.chars ?? 0;
}

function lifecycleOf(
  b: ContextBreakdown,
  category: string
): string | undefined {
  return b.segments.find((s) => s.category === category)?.lifecycle;
}

describe("estimateTokens", () => {
  it("is ceil(chars / 4)", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(400)).toBe(100);
  });
});

describe("analyzeContext", () => {
  it("segments a rendered prompt into commits / learnings / inputs / playbook", () => {
    const prompt = [
      "<commits>",
      "abc123 fix things",
      "</commits>",
      "",
      "<learnings>",
      "# Otto learnings",
      "be careful",
      "</learnings>",
      "",
      "<inputs>",
      "the plan and prd",
      "</inputs>",
      "",
      "# THE TASK",
      "do the work",
    ].join("\n");

    const b = analyzeContext(prompt);

    // Every category that has content is present; the four sum to the whole.
    expect(charsOf(b, "commits")).toBeGreaterThan(0);
    expect(charsOf(b, "learnings")).toBeGreaterThan(0);
    expect(charsOf(b, "inputs")).toBeGreaterThan(0);
    expect(charsOf(b, "playbook")).toBeGreaterThan(0);

    const sum = b.segments.reduce((acc, s) => acc + s.chars, 0);
    expect(sum).toBe(prompt.length);
    expect(b.totalChars).toBe(prompt.length);
    expect(b.estimatedTokens).toBe(estimateTokens(prompt.length));
  });

  it("derives a lifecycle class onto each segment", () => {
    const prompt = [
      "<commits>",
      "abc123 fix things",
      "</commits>",
      "<learnings>",
      "# Otto learnings",
      "be careful",
      "</learnings>",
      "<inputs>",
      "the plan and prd",
      "</inputs>",
      "# THE TASK",
      "do the work",
    ].join("\n");

    const b = analyzeContext(prompt);

    expect(lifecycleOf(b, "commits")).toBe("resolved");
    expect(lifecycleOf(b, "learnings")).toBe("durable");
    expect(lifecycleOf(b, "inputs")).toBe("required-now");
    expect(lifecycleOf(b, "playbook")).toBe("required-now");
    // every present segment carries a lifecycle
    expect(b.segments.every((s) => typeof s.lifecycle === "string")).toBe(true);
  });

  it("keeps afk <inputs> as inputs/required-now but treats ghafk issue-body tags as evidence/retrievable", () => {
    const prompt = [
      "<inputs>",
      "the plan and prd",
      "</inputs>",
      "<issue>",
      "a single issue body",
      "</issue>",
      "<issues-summary>",
      "1: a  2: b",
      "</issues-summary>",
      "<issues-full-file>",
      "spilled to a file",
      "</issues-full-file>",
      "rest is playbook",
    ].join("\n");

    const b = analyzeContext(prompt);
    // The active afk task source stays required-now — it IS the current task.
    expect(charsOf(b, "inputs")).toBeGreaterThan(0);
    expect(lifecycleOf(b, "inputs")).toBe("required-now");
    // All three ghafk issue-body tags fold into one retrievable evidence segment.
    expect(charsOf(b, "evidence")).toBeGreaterThan(0);
    expect(b.segments.filter((s) => s.category === "evidence")).toHaveLength(1);
    expect(lifecycleOf(b, "evidence")).toBe("retrievable");
    expect(charsOf(b, "playbook")).toBeGreaterThan(0);
  });

  it("buckets text outside any recognized block as playbook", () => {
    const prompt = "just instructions, no blocks at all";
    const b = analyzeContext(prompt);
    expect(charsOf(b, "playbook")).toBe(prompt.length);
    expect(b.segments).toHaveLength(1);
    expect(b.segments[0].category).toBe("playbook");
  });

  it("omits a category that has no content (absent block)", () => {
    const prompt = "<learnings>\nx\n</learnings>\nplaybook";
    const b = analyzeContext(prompt);
    expect(b.segments.some((s) => s.category === "commits")).toBe(false);
    expect(b.segments.some((s) => s.category === "inputs")).toBe(false);
  });

  it("sorts segments by chars descending", () => {
    const prompt = [
      "<commits>",
      "x",
      "</commits>",
      "<learnings>",
      "a much much much much much longer learnings block here",
      "</learnings>",
    ].join("\n");
    const b = analyzeContext(prompt);
    const sizes = b.segments.map((s) => s.chars);
    expect(sizes).toEqual([...sizes].sort((p, q) => q - p));
    expect(b.segments[0].category).toBe("learnings");
  });

  it("handles an empty prompt without throwing", () => {
    const b = analyzeContext("");
    expect(b.totalChars).toBe(0);
    expect(b.estimatedTokens).toBe(0);
    expect(b.segments).toEqual([]);
  });
});

describe("formatContextReport", () => {
  it("renders each present category with a percentage and a token estimate", () => {
    const prompt = [
      "<learnings>",
      "be careful with the renderer",
      "</learnings>",
      "# THE TASK",
      "do the work now",
    ].join("\n");
    const out = formatContextReport(analyzeContext(prompt));
    expect(out).toMatch(/learnings/);
    expect(out).toMatch(/playbook/);
    expect(out).toMatch(/%/);
    // estimate is labelled as approximate, not authoritative billing
    expect(out).toMatch(/~/);
  });

  it("does not throw on an empty breakdown", () => {
    expect(() => formatContextReport(analyzeContext(""))).not.toThrow();
  });
});
