import { describe, expect, it } from "vitest";
import { formatEnforcementReport } from "../context-enforcement.js";
import type { ContextEnforcementEvent } from "../context-enforcement.js";

const ev = (
  over: Partial<ContextEnforcementEvent>
): ContextEnforcementEvent => ({
  lever: "bound-learnings",
  beforeTokens: 100,
  afterTokens: 60,
  stage: "implementer",
  ...over,
});

describe("formatEnforcementReport", () => {
  it("is empty when nothing was enforced or advised", () => {
    expect(formatEnforcementReport([], null)).toBe("");
  });

  it("lists Enforced actions with their measured saving", () => {
    const out = formatEnforcementReport([ev({})], null);
    expect(out).toContain("Enforced");
    expect(out).toContain("bound-learnings");
    expect(out).toContain("40"); // 100 -> 60
    expect(out).toContain("implementer");
  });

  it("separates Advisory from Enforced", () => {
    // Over budget with no lever pulled is advice, not an action — conflating
    // them would let a report claim savings it never made.
    const out = formatEnforcementReport([], {
      overByTokens: 500,
      category: "evidence",
      lever: "reversible evidence compression",
    });
    expect(out).toContain("Advisory");
    expect(out).toContain("evidence");
    expect(out).not.toContain("Enforced");
  });

  it("reports a skipped lever as advisory, never as a saving", () => {
    const out = formatEnforcementReport(
      [ev({ skipped: "invariant-violation", afterTokens: 100 })],
      null
    );
    expect(out).not.toContain("Enforced");
    expect(out).toMatch(/skipped|invariant/i);
  });

  it("shows both sections when some levers fired and the prompt is still over", () => {
    const out = formatEnforcementReport([ev({})], {
      overByTokens: 200,
      category: "commits",
      lever: "commit compaction",
    });
    expect(out).toContain("Enforced");
    expect(out).toContain("Advisory");
  });
});
