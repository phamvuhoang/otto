import { describe, expect, it } from "vitest";

import { analyzeContext, type ContextCategory } from "../context-report.js";
import {
  assessFreeableContext,
  classifyLifecycle,
  formatFreeableContext,
  lifecycleRationale,
  summarizeLifecycle,
  type ContextLifecycle,
} from "../context-lifecycle.js";

describe("classifyLifecycle", () => {
  it("maps every context category to its lifecycle class (total function)", () => {
    const table: Array<[ContextCategory, ContextLifecycle]> = [
      ["playbook", "required-now"],
      ["inputs", "required-now"],
      ["commits", "resolved"],
      ["learnings", "durable"],
      ["evidence", "retrievable"],
    ];
    for (const [category, lifecycle] of table) {
      expect(classifyLifecycle(category)).toBe(lifecycle);
    }
  });
});

describe("lifecycleRationale", () => {
  it("returns a distinct, non-empty 'why is this still in context?' rationale per class", () => {
    const classes: ContextLifecycle[] = [
      "required-now",
      "resolved",
      "durable",
      "retrievable",
    ];
    const rationales = classes.map((c) => lifecycleRationale(c));
    // Every class has a non-empty rationale.
    for (const r of rationales) {
      expect(r.length).toBeGreaterThan(0);
    }
    // The four rationales are all distinct.
    expect(new Set(rationales).size).toBe(classes.length);
  });
});

describe("summarizeLifecycle", () => {
  it("rolls a breakdown up by lifecycle, totals summing to the breakdown total", () => {
    const prompt = [
      "<commits>",
      "abc123 settled work",
      "</commits>",
      "<learnings>",
      "# Otto learnings",
      "durable knowledge",
      "</learnings>",
      "<inputs>",
      "the current task",
      "</inputs>",
      "# THE TASK — playbook instructions live out here",
    ].join("\n");
    const breakdown = analyzeContext(prompt);
    const summary = summarizeLifecycle(breakdown);

    // Char totals partition the prompt exactly.
    const charSum = summary.byLifecycle.reduce((a, b) => a + b.chars, 0);
    expect(charSum).toBe(breakdown.totalChars);
    expect(summary.totalChars).toBe(breakdown.totalChars);

    // Token totals sum to the per-segment token total (rounding-stable).
    const segmentTokenSum = breakdown.segments.reduce(
      (a, s) => a + s.estimatedTokens,
      0
    );
    const tokenSum = summary.byLifecycle.reduce(
      (a, b) => a + b.estimatedTokens,
      0
    );
    expect(tokenSum).toBe(segmentTokenSum);
    expect(summary.estimatedTokens).toBe(segmentTokenSum);
  });

  it("folds same-lifecycle categories together (playbook + inputs → required-now)", () => {
    const prompt = [
      "<inputs>",
      "task source",
      "</inputs>",
      "playbook prose",
    ].join("\n");
    const breakdown = analyzeContext(prompt);
    const summary = summarizeLifecycle(breakdown);

    const requiredNow = summary.byLifecycle.find(
      (l) => l.lifecycle === "required-now"
    );
    expect(requiredNow).toBeDefined();
    // inputs + playbook chars both land under required-now.
    expect(requiredNow?.chars).toBe(breakdown.totalChars);
    // The two source categories collapse into a single lifecycle entry.
    expect(summary.byLifecycle).toHaveLength(1);
  });

  it("returns an empty rollup for an empty breakdown", () => {
    const summary = summarizeLifecycle({
      totalChars: 0,
      estimatedTokens: 0,
      segments: [],
    });
    expect(summary.byLifecycle).toEqual([]);
    expect(summary.totalChars).toBe(0);
    expect(summary.estimatedTokens).toBe(0);
  });
});

describe("assessFreeableContext", () => {
  it("names a large resolved (commits) segment as retirable with a token estimate", () => {
    const prompt = [
      "<commits>",
      "abc123 settled work ".repeat(500),
      "</commits>",
      "<inputs>",
      "the current task",
      "</inputs>",
      "# THE TASK — playbook instructions",
    ].join("\n");
    const breakdown = analyzeContext(prompt);
    const assessment = assessFreeableContext(breakdown);

    const resolved = assessment.segments.find(
      (s) => s.lifecycle === "resolved"
    );
    expect(resolved).toBeDefined();
    expect(resolved?.action).toBe("retire");

    // The freed token estimate matches the resolved (commits) segment exactly,
    // so the dry-run report is rounding-stable against the breakdown.
    const commits = breakdown.segments.find((s) => s.category === "commits");
    expect(resolved?.chars).toBe(commits?.chars);
    expect(resolved?.estimatedTokens).toBe(commits?.estimatedTokens);
    expect(assessment.freeableChars).toBe(commits?.chars);
    expect(assessment.freeableTokens).toBe(commits?.estimatedTokens);
  });

  it("reports zero freeable when only required-now/durable context is present", () => {
    const prompt = [
      "<learnings>",
      "# Otto learnings",
      "durable knowledge",
      "</learnings>",
      "<inputs>",
      "the current task",
      "</inputs>",
      "# THE TASK — playbook prose",
    ].join("\n");
    const breakdown = analyzeContext(prompt);
    const assessment = assessFreeableContext(breakdown);

    expect(assessment.segments).toEqual([]);
    expect(assessment.freeableChars).toBe(0);
    expect(assessment.freeableTokens).toBe(0);
  });

  it("returns zero freeable for an empty breakdown", () => {
    const assessment = assessFreeableContext({
      totalChars: 0,
      estimatedTokens: 0,
      segments: [],
    });
    expect(assessment.segments).toEqual([]);
    expect(assessment.freeableChars).toBe(0);
    expect(assessment.freeableTokens).toBe(0);
  });

  it("formats a one-line human summary, both freeable and none", () => {
    const freeable = formatFreeableContext(
      assessFreeableContext(
        analyzeContext(
          ["<commits>", "abc123 settled work", "</commits>"].join("\n")
        )
      )
    );
    expect(freeable).toMatch(/^freeable context:/);
    expect(freeable).toContain("retire");
    expect(freeable.toLowerCase()).toContain("resolved");

    const none = formatFreeableContext(
      assessFreeableContext(analyzeContext("just playbook prose"))
    );
    expect(none).toMatch(/^freeable context: none/);
  });
});
