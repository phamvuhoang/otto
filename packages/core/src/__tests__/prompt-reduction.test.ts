import { describe, expect, it } from "vitest";

import { applyPromptReduction } from "../prompt-reduction.js";

describe("applyPromptReduction", () => {
  it("compacts redundant blank lines and trailing spaces without removing sections", () => {
    const prompt = "<inputs>   \n\n\n\n\nRead ./full.txt   \n</inputs>\n";
    const reduced = applyPromptReduction(prompt);
    expect(reduced.prompt).toBe("<inputs>\n\n\nRead ./full.txt\n</inputs>\n");
    expect(reduced.prompt).toContain("Read ./full.txt");
    expect(reduced.stats.originalChars).toBe(prompt.length);
    expect(reduced.stats.reducedChars).toBeLessThan(prompt.length);
  });

  it("reports zero cache stats for the conservative MVP", () => {
    const reduced = applyPromptReduction("x");
    expect(reduced.stats.cacheHits).toBe(0);
    expect(reduced.stats.cacheMisses).toBe(0);
  });
});
