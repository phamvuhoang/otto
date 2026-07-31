import { describe, expect, it } from "vitest";
import { assessContextBudget } from "../context-budget.js";
import type { ContextBreakdown } from "../context-report.js";

const breakdown = (
  segs: { category: string; chars: number }[]
): ContextBreakdown => {
  const totalChars = segs.reduce((n, s) => n + s.chars, 0);
  return {
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 4),
    segments: segs
      .slice()
      .sort((a, b) => b.chars - a.chars)
      .map((s) => ({
        category: s.category as never,
        chars: s.chars,
        share: s.chars / totalChars,
        lifecycle: "retrievable" as never,
      })),
  };
};

describe("assessContextBudget recommends the lever that will actually fire", () => {
  it("names the compression lever when evidence dominates", () => {
    // Before P30 this recommended <commits> — the first category in
    // REDUCIBLE_LEVERS — while the enforcement ladder's compress-spill rung is
    // what actually fires on an evidence-heavy prompt. Advice and behavior
    // named different levers on exactly the prompts enforcement helps most.
    const a = assessContextBudget(
      breakdown([
        { category: "evidence", chars: 400_000 },
        { category: "commits", chars: 2_000 },
        { category: "playbook", chars: 8_000 },
      ]),
      { maxTokens: 1_000 }
    );
    expect(a.overBudget).toBe(true);
    expect(a.recommendation?.category).toBe("evidence");
    expect(a.recommendation?.lever).toMatch(/compress/i);
  });

  it("still names commits when commits dominate", () => {
    const a = assessContextBudget(
      breakdown([
        { category: "commits", chars: 400_000 },
        { category: "evidence", chars: 2_000 },
      ]),
      { maxTokens: 1_000 }
    );
    expect(a.recommendation?.category).toBe("commits");
  });

  it("never recommends a category no lever can shrink", () => {
    const a = assessContextBudget(
      breakdown([
        { category: "inputs", chars: 400_000 },
        { category: "playbook", chars: 100_000 },
      ]),
      { maxTokens: 1_000 }
    );
    expect(a.overBudget).toBe(true);
    expect(a.recommendation).toBeUndefined();
  });

  it("recommends nothing when within budget", () => {
    const a = assessContextBudget(
      breakdown([{ category: "evidence", chars: 100 }]),
      { maxTokens: 1_000_000 }
    );
    expect(a.overBudget).toBe(false);
    expect(a.recommendation).toBeUndefined();
  });
});
