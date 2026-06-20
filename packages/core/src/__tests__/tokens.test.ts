import { describe, expect, it } from "vitest";

import {
  addTokenUsage,
  emptyTokenUsage,
  formatCacheEfficiency,
  formatTokenUsage,
  parseTokenMode,
  parseTokenUsage,
  summarizeCacheEfficiency,
  tokenUsageTotal,
} from "../tokens.js";

describe("parseTokenUsage", () => {
  it("extracts usage fields from a result event", () => {
    expect(
      parseTokenUsage({
        usage: {
          input_tokens: 7739,
          output_tokens: 569,
          cache_creation_input_tokens: 12,
          cache_read_input_tokens: 103036,
        },
      })
    ).toEqual({
      inputTokens: 7739,
      outputTokens: 569,
      cacheCreationInputTokens: 12,
      cacheReadInputTokens: 103036,
    });
  });

  it("defaults missing or malformed fields to zero", () => {
    expect(
      parseTokenUsage({
        usage: {
          input_tokens: "10",
          output_tokens: -1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: Number.POSITIVE_INFINITY,
        },
      })
    ).toEqual(emptyTokenUsage());
  });

  it("adds and totals token usage", () => {
    const total = addTokenUsage(
      {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
      {
        inputTokens: 7,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 11,
      }
    );
    expect(total).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 15,
    });
    expect(tokenUsageTotal(total)).toBe(38);
  });
});

describe("formatTokenUsage", () => {
  it("formats stage token usage for console output", () => {
    expect(
      formatTokenUsage({
        inputTokens: 7739,
        outputTokens: 569,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 103036,
      })
    ).toBe(
      "in 7,739 | out 569 | cache create 0 | cache read 103,036 | total 111,344"
    );
  });
});

describe("summarizeCacheEfficiency", () => {
  it("aggregates usages and computes the input cache-hit rate", () => {
    const eff = summarizeCacheEfficiency([
      {
        inputTokens: 1000,
        outputTokens: 50,
        cacheCreationInputTokens: 4000,
        cacheReadInputTokens: 0,
      },
      {
        inputTokens: 1000,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4000,
      },
    ]);
    expect(eff).toEqual({
      inputTokens: 2000,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 4000,
      totalInputTokens: 10000,
      // 4000 read / (2000 + 4000 + 4000) input = 0.4
      hitRate: 0.4,
    });
  });

  it("reports a zero hit rate (no divide-by-zero) when there is no input", () => {
    const eff = summarizeCacheEfficiency([emptyTokenUsage()]);
    expect(eff.totalInputTokens).toBe(0);
    expect(eff.hitRate).toBe(0);
  });

  it("treats an empty list as zero usage", () => {
    const eff = summarizeCacheEfficiency([]);
    expect(eff.totalInputTokens).toBe(0);
    expect(eff.hitRate).toBe(0);
  });
});

describe("formatCacheEfficiency", () => {
  it("renders the hit rate and the read/created/uncached split", () => {
    const line = formatCacheEfficiency({
      inputTokens: 2000,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 4000,
      totalInputTokens: 10000,
      hitRate: 0.4,
    });
    expect(line).toContain("40%");
    expect(line).toContain("cache read 4,000");
    expect(line).toContain("cache create 4,000");
    expect(line).toContain("uncached 2,000");
  });
});

describe("parseTokenMode", () => {
  it.each(["off", "measure", "reduce"] as const)("accepts %s", (mode) => {
    expect(parseTokenMode(mode)).toBe(mode);
  });

  it("defaults unset or empty mode to off", () => {
    expect(parseTokenMode(undefined)).toBe("off");
    expect(parseTokenMode(" ")).toBe("off");
  });

  it("rejects invalid modes with source context", () => {
    expect(() => parseTokenMode("aggressive", "OTTO_TOKEN_MODE")).toThrow(
      /OTTO_TOKEN_MODE must be one of off\|measure\|reduce/
    );
  });
});
