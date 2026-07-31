import { describe, expect, it } from "vitest";

import { applyPromptReduction } from "../prompt-reduction.js";
import { DEFAULT_COMMITS_BUDGET_CHARS } from "../iteration-compaction.js";

/** A rendered `<commits>` block in the shape afk.md's git-log tag produces. */
function commitsBlock(count: number, bodyChars: number): string {
  const entries = Array.from({ length: count }, (_, i) => {
    const hash = `${i}`.padStart(40, "a");
    const body = `subject ${i}\n\n${"detail line\n".repeat(
      Math.ceil(bodyChars / 12)
    )}`;
    return `${hash}\n2026-07-3${i % 10}\n${body}---`;
  }).join("\n");
  return `<commits>\n\n${entries}\n\n</commits>\n`;
}

describe("applyPromptReduction", () => {
  it("compacts redundant blank lines and trailing spaces without removing sections", () => {
    const prompt = "<inputs>   \n\n\n\n\nRead ./full.txt   \n</inputs>\n";
    const reduced = applyPromptReduction(prompt);
    expect(reduced.prompt).toBe("<inputs>\n\n\nRead ./full.txt\n</inputs>\n");
    expect(reduced.prompt).toContain("Read ./full.txt");
    expect(reduced.stats.originalChars).toBe(prompt.length);
    expect(reduced.stats.reducedChars).toBeLessThan(prompt.length);
  });

  it("reports what it actually saved, split by lever", () => {
    const prompt = "<inputs>   \n\n\n\n\nkeep me   \n</inputs>\n";
    const { stats } = applyPromptReduction(prompt);
    expect(stats.whitespaceSavedChars).toBeGreaterThan(0);
    expect(stats.commitsSavedChars).toBe(0);
    expect(stats.originalChars - stats.reducedChars).toBe(
      stats.whitespaceSavedChars + stats.commitsSavedChars
    );
  });

  it("compacts an over-budget <commits> block to subjects", () => {
    const prompt = commitsBlock(5, 900);
    const { prompt: out, stats } = applyPromptReduction(prompt);
    expect(stats.commitsSavedChars).toBeGreaterThan(0);
    expect(out).toContain("Compacted:");
    expect(out).toContain("subject 0"); // subjects survive
    expect(out.length).toBeLessThan(prompt.length);
  });

  it("leaves an under-budget <commits> block alone", () => {
    const prompt = commitsBlock(2, 40);
    expect(prompt.length).toBeLessThan(DEFAULT_COMMITS_BUDGET_CHARS);
    const { prompt: out, stats } = applyPromptReduction(prompt);
    expect(stats.commitsSavedChars).toBe(0);
    expect(out).not.toContain("Compacted:");
  });

  it("leaves a prompt with no <commits> block untouched by the commits lever", () => {
    const { stats } = applyPromptReduction("just some prose\n");
    expect(stats.commitsSavedChars).toBe(0);
  });

  it("never grows the prompt", () => {
    for (const p of [
      "x",
      commitsBlock(1, 10),
      commitsBlock(6, 1200),
      "<commits>\n\nnot a parseable log\n\n</commits>\n",
    ]) {
      expect(applyPromptReduction(p).prompt.length).toBeLessThanOrEqual(
        p.length
      );
    }
  });
});
