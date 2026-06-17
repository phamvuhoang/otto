export type TokenMode = "off" | "measure" | "reduce";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function usageObject(ev: unknown): Record<string, unknown> {
  const e = (ev ?? {}) as Record<string, unknown>;
  return (e.usage ?? {}) as Record<string, unknown>;
}

function usageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Parse Claude stream-json result-event token usage. Missing fields are zero. */
export function parseTokenUsage(ev: unknown): TokenUsage {
  const u = usageObject(ev);
  return {
    inputTokens: usageNumber(u.input_tokens),
    outputTokens: usageNumber(u.output_tokens),
    cacheCreationInputTokens: usageNumber(u.cache_creation_input_tokens),
    cacheReadInputTokens: usageNumber(u.cache_read_input_tokens),
  };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

export function tokenUsageTotal(u: TokenUsage): number {
  return (
    u.inputTokens +
    u.outputTokens +
    u.cacheCreationInputTokens +
    u.cacheReadInputTokens
  );
}

const fmt = new Intl.NumberFormat("en-US");

export function formatTokenUsage(u: TokenUsage): string {
  return [
    `in ${fmt.format(u.inputTokens)}`,
    `out ${fmt.format(u.outputTokens)}`,
    `cache create ${fmt.format(u.cacheCreationInputTokens)}`,
    `cache read ${fmt.format(u.cacheReadInputTokens)}`,
    `total ${fmt.format(tokenUsageTotal(u))}`,
  ].join(" | ");
}

export function parseTokenMode(
  raw: string | undefined,
  source = "--token-mode"
): TokenMode {
  const trimmed = raw?.trim();
  if (!trimmed) return "off";
  if (trimmed === "off" || trimmed === "measure" || trimmed === "reduce") {
    return trimmed;
  }
  throw new Error(
    `${source} must be one of off|measure|reduce, got: ${JSON.stringify(raw)}`
  );
}
