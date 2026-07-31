import {
  compactCommits,
  formatCompactedCommits,
  parseCommitLog,
} from "./iteration-compaction.js";

/**
 * What `--token-mode reduce` actually saved, split by lever so the reported
 * number is attributable rather than a single opaque delta.
 *
 * The previous shape carried `cacheHits`/`cacheMisses`, both hardcoded to 0 —
 * it reported a cache statistic this module never measured. They are gone;
 * real cache reads come from the runtime and are parsed in `tokens.ts` as
 * `cacheReadInputTokens`.
 */
export type PromptReductionStats = {
  originalChars: number;
  reducedChars: number;
  whitespaceSavedChars: number;
  commitsSavedChars: number;
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

const COMMITS_BLOCK = /<commits>\n([\s\S]*?)\n<\/commits>/;

/**
 * Degrade an over-budget rendered `<commits>` block to subject-only entries via
 * the `compactCommits` substrate — built, tested and exported in P7 slice 6,
 * and until now called by nothing.
 *
 * Conservative: a block that does not parse as a commit log, or whose
 * compaction would not actually shrink the prompt, is left exactly as it was.
 */
function compactCommitsBlock(prompt: string): {
  prompt: string;
  saved: number;
} {
  const match = COMMITS_BLOCK.exec(prompt);
  if (!match) return { prompt, saved: 0 };
  const original = match[1];
  const entries = parseCommitLog(original);
  if (entries.length === 0) return { prompt, saved: 0 };
  const compacted = compactCommits(entries);
  if (compacted.compacted.length === 0) return { prompt, saved: 0 };
  const replacement = formatCompactedCommits(compacted);
  if (replacement.length >= original.length) return { prompt, saved: 0 };
  return {
    prompt: prompt.replace(original, replacement),
    saved: original.length - replacement.length,
  };
}

/**
 * Conservative prompt reduction for `--token-mode reduce`. It never removes
 * semantic sections, source paths, spill references, or instructions.
 *
 * Two levers, both honest about what they dropped: older commit bodies degrade
 * to their subjects (carrying `formatCompactedCommits`' "N compacted" note),
 * and whitespace that cannot change what the agent is asked to do is collapsed.
 */
export function applyPromptReduction(prompt: string): ReducedPrompt {
  const { prompt: afterCommits, saved: commitsSavedChars } =
    compactCommitsBlock(prompt);
  const reduced = compactWhitespace(afterCommits);
  return {
    prompt: reduced,
    stats: {
      originalChars: prompt.length,
      reducedChars: reduced.length,
      whitespaceSavedChars: afterCommits.length - reduced.length,
      commitsSavedChars,
    },
  };
}
