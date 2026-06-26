import { describe, expect, it } from "vitest";

import { analyzeContext, type ContextCategory } from "../context-report.js";
import {
  classifyLifecycle,
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
    ];
    for (const [category, lifecycle] of table) {
      expect(classifyLifecycle(category)).toBe(lifecycle);
    }
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
    const prompt = ["<inputs>", "task source", "</inputs>", "playbook prose"].join(
      "\n"
    );
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
