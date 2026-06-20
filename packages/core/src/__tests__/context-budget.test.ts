import { describe, expect, it } from "vitest";

import type { ContextBreakdown } from "../context-report.js";
import {
  DEFAULT_CONTEXT_BUDGET_FRACTION,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  assessContextBudget,
  formatContextBudget,
  modelContextBudget,
  modelContextWindow,
} from "../context-budget.js";

/** Build a ContextBreakdown from category→chars pairs (estimate = ceil/4). */
function breakdown(segs: Array<[string, number]>): ContextBreakdown {
  const totalChars = segs.reduce((a, [, c]) => a + c, 0);
  return {
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 4),
    segments: segs
      .map(([category, chars]) => ({
        category: category as ContextBreakdown["segments"][number]["category"],
        chars,
        estimatedTokens: Math.ceil(chars / 4),
      }))
      .sort((a, b) => b.chars - a.chars),
  };
}

describe("modelContextWindow", () => {
  it("maps known model families to their context window", () => {
    expect(modelContextWindow("claude-opus-4-8")).toBe(200_000);
    expect(modelContextWindow("sonnet")).toBe(200_000);
    expect(modelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("recognizes the 1M context marker regardless of family", () => {
    expect(modelContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(modelContextWindow("claude-sonnet-4-6-1m")).toBe(1_000_000);
  });

  it("falls back to the conservative default for unknown/unset specs", () => {
    expect(modelContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(modelContextWindow("")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(modelContextWindow("some-future-model")).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS
    );
  });
});

describe("modelContextBudget", () => {
  it("is the default fraction of the model window", () => {
    expect(modelContextBudget("claude-opus-4-8")).toBe(
      Math.round(200_000 * DEFAULT_CONTEXT_BUDGET_FRACTION)
    );
  });

  it("honors a custom fraction", () => {
    expect(modelContextBudget("claude-opus-4-8[1m]", 0.1)).toBe(100_000);
  });
});

describe("assessContextBudget", () => {
  it("reports headroom and no recommendation when under budget", () => {
    const a = assessContextBudget(breakdown([["playbook", 4000]]), {
      model: "claude-opus-4-8",
    });
    expect(a.estimatedTokens).toBe(1000);
    expect(a.budgetTokens).toBe(50_000);
    expect(a.windowTokens).toBe(200_000);
    expect(a.overBudget).toBe(false);
    expect(a.overByTokens).toBe(0);
    expect(a.headroomTokens).toBe(49_000);
    expect(a.recommendation).toBeUndefined();
  });

  it("flags over-budget and recommends compacting the largest reducible filler", () => {
    // 240k chars → 60k tokens, over the 50k budget. learnings is the largest
    // reducible category (commits/learnings are the P7 compaction levers).
    const a = assessContextBudget(
      breakdown([
        ["learnings", 160_000],
        ["commits", 40_000],
        ["inputs", 40_000],
      ]),
      { model: "claude-opus-4-8" }
    );
    expect(a.overBudget).toBe(true);
    expect(a.estimatedTokens).toBe(60_000);
    expect(a.overByTokens).toBe(10_000);
    expect(a.headroomTokens).toBe(0);
    expect(a.recommendation?.category).toBe("learnings");
    expect(a.recommendation?.lever).toMatch(/boundLearnings/);
  });

  it("recommends commit compaction when commits are the largest reducible filler", () => {
    const a = assessContextBudget(
      breakdown([
        ["commits", 200_000],
        ["learnings", 40_000],
      ]),
      { model: "claude-opus-4-8" }
    );
    expect(a.overBudget).toBe(true);
    expect(a.recommendation?.category).toBe("commits");
    expect(a.recommendation?.lever).toMatch(/compactCommits/);
  });

  it("gives no recommendation when only non-reducible categories overflow", () => {
    // inputs (task source) + playbook (instructions) are not P7-reducible.
    const a = assessContextBudget(
      breakdown([
        ["inputs", 160_000],
        ["playbook", 80_000],
      ]),
      { model: "claude-opus-4-8" }
    );
    expect(a.overBudget).toBe(true);
    expect(a.recommendation).toBeUndefined();
  });

  it("honors an explicit token budget over the model-derived one", () => {
    const a = assessContextBudget(breakdown([["playbook", 8000]]), {
      maxTokens: 1000,
    });
    expect(a.budgetTokens).toBe(1000);
    expect(a.estimatedTokens).toBe(2000);
    expect(a.overBudget).toBe(true);
    expect(a.ratio).toBe(2);
  });

  it("ratio is 0 when the budget is 0 (no divide-by-zero)", () => {
    const a = assessContextBudget(breakdown([["playbook", 400]]), {
      maxTokens: 0,
    });
    expect(a.ratio).toBe(0);
    expect(a.overBudget).toBe(true);
  });
});

describe("formatContextBudget", () => {
  it("renders a within-budget line", () => {
    const out = formatContextBudget(
      assessContextBudget(breakdown([["playbook", 4000]]), {
        model: "claude-opus-4-8",
      })
    );
    expect(out).toMatch(/within budget/i);
    expect(out).toContain("1,000");
    expect(out).toContain("50,000");
  });

  it("renders an over-budget warning naming the lever", () => {
    const out = formatContextBudget(
      assessContextBudget(breakdown([["learnings", 240_000]]), {
        model: "claude-opus-4-8",
      })
    );
    expect(out).toMatch(/exceeds/i);
    expect(out).toContain("learnings");
    expect(out).toMatch(/boundLearnings/);
  });
});
