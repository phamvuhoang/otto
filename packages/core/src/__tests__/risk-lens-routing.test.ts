// packages/core/src/__tests__/risk-lens-routing.test.ts
import { describe, expect, it } from "vitest";
import { classifyRisk, reviewDepthForLevel, selectLenses } from "../risk.js";

const POOL = ["correctness", "security", "tests", "task-fit", "structural"];

describe("structural lens routing", () => {
  it("runs structural at panel depth (high-risk, cross-module change)", () => {
    const lenses = selectLenses("panel", POOL);
    expect(lenses).toContain("structural");
  });

  it("omits structural at lenses depth (medium risk)", () => {
    expect(selectLenses("lenses", POOL)).not.toContain("structural");
  });

  it("a docs-only change does not reach panel depth", () => {
    const depth = reviewDepthForLevel(classifyRisk(["README.md", "docs/x.md"]).level);
    expect(depth).not.toBe("panel");
  });
});
