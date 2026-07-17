import { describe, it, expect } from "vitest";
import { analyzeContext } from "../context-report.js";

describe("graph-map lifecycle", () => {
  it("classifies an injected <graph-map> block as retrievable evidence", () => {
    const prompt = "before\n<graph-map>\narch summary\n</graph-map>\nafter";
    const breakdown = analyzeContext(prompt);
    const evidence = breakdown.segments.find((s) => s.category === "evidence");
    expect(evidence).toBeDefined();
    expect(evidence?.lifecycle).toBe("retrievable");
  });
});
