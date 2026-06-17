export type PromptReductionStats = {
  originalChars: number;
  reducedChars: number;
  cacheHits: number;
  cacheMisses: number;
};

export type ReducedPrompt = {
  prompt: string;
  stats: PromptReductionStats;
};

function compactWhitespace(prompt: string): string {
  return prompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Conservative prompt reduction. It never removes semantic sections, source
 * paths, spill references, or instructions; it only compacts whitespace that
 * cannot change what the agent is asked to do.
 */
export function applyPromptReduction(prompt: string): ReducedPrompt {
  const reduced = compactWhitespace(prompt);
  return {
    prompt: reduced,
    stats: {
      originalChars: prompt.length,
      reducedChars: reduced.length,
      cacheHits: 0,
      cacheMisses: 0,
    },
  };
}
