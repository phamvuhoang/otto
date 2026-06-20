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

/**
 * Cache efficiency over a run's stage token usage (issue #62 P7, slice 4).
 *
 * `hitRate` is the fraction of *input* tokens served from the prompt cache —
 * `cacheRead / (input + cacheCreation + cacheRead)` — so it answers the issue's
 * success metric "cache-hit rate on the static prefix reported and non-trivial".
 * Output tokens are excluded: they are generated, never cacheable input.
 */
export type CacheEfficiency = {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** input + cacheCreation + cacheRead — the denominator of `hitRate`. */
  totalInputTokens: number;
  /** cacheRead / totalInputTokens, in 0..1; 0 when there is no input. */
  hitRate: number;
};

/** Aggregate per-stage usages into one cache-efficiency summary. Pure. */
export function summarizeCacheEfficiency(usages: TokenUsage[]): CacheEfficiency {
  const agg = usages.reduce(addTokenUsage, emptyTokenUsage());
  const totalInputTokens =
    agg.inputTokens + agg.cacheCreationInputTokens + agg.cacheReadInputTokens;
  return {
    inputTokens: agg.inputTokens,
    cacheCreationInputTokens: agg.cacheCreationInputTokens,
    cacheReadInputTokens: agg.cacheReadInputTokens,
    totalInputTokens,
    hitRate:
      totalInputTokens > 0 ? agg.cacheReadInputTokens / totalInputTokens : 0,
  };
}

const cachePct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Render a cache-efficiency summary as a one-line console string. */
export function formatCacheEfficiency(e: CacheEfficiency): string {
  return (
    `cache efficiency: ${cachePct.format(e.hitRate * 100)}% of input tokens ` +
    `served from cache (cache read ${fmt.format(e.cacheReadInputTokens)} · ` +
    `cache create ${fmt.format(e.cacheCreationInputTokens)} · ` +
    `uncached ${fmt.format(e.inputTokens)})`
  );
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
