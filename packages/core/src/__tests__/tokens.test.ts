import { describe, expect, it } from "vitest";

import {
  addTokenUsage,
  emptyTokenUsage,
  formatTokenUsage,
  parseTokenMode,
  parseTokenUsage,
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
