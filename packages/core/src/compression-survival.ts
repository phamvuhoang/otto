/**
 * Fact-survival measurement for context compression (issue #179 P22).
 *
 * The roadmap gates trusting (and later expanding) Headroom compression on one
 * condition: *"use Headroom selectively for `retrievable` categories where **eval
 * proves buried facts survive compression**."* Compression (`context-compressor.ts`,
 * `headroom-adapter.ts`) already shrinks retrievable content and measures the
 * token savings — but token savings alone cannot tell you whether a specific
 * load-bearing fact (an error code, a version, a file path) *survived* the
 * summarization. This module answers that orthogonal question.
 *
 * Pure: it takes a known set of "buried facts" and the compressed text and
 * reports which facts still appear. Evals score survival against facts they
 * supply; the runtime keep-decision (`context-compressor.ts`, issue #200)
 * scores it against anchors mechanically extracted from the original via
 * {@link extractAnchors}, so a compression that drops a load-bearing
 * identifier is rejected instead of used.
 */

/** The outcome of scoring a fact set against one piece of compressed text. */
export type FactSurvival = {
  /** How many facts were checked. */
  total: number;
  /** How many facts still appear in the compressed text. */
  survived: number;
  /** `survived / total`, or `1` for an empty fact set (vacuously all survive). */
  survivalRate: number;
  /** The facts that did not appear, in input order. */
  missing: string[];
};

/** Lowercase + collapse internal whitespace + trim, so a summarizer that changes
 *  spacing/case around a salient token does not read as a dropped fact. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Score how many `facts` survive in `compressedText`. A fact "survives" when it
 * appears as a normalized (case-insensitive, whitespace-collapsed) substring —
 * robust to a summarizer rephrasing *around* a distinctive identifier while still
 * catching a token that is dropped entirely. Pure.
 */
export function assessFactSurvival(
  facts: string[],
  compressedText: string
): FactSurvival {
  const haystack = normalize(compressedText);
  const missing = facts.filter((f) => !haystack.includes(normalize(f)));
  const survived = facts.length - missing.length;
  return {
    total: facts.length,
    survived,
    survivalRate: facts.length === 0 ? 1 : survived / facts.length,
    missing,
  };
}

/**
 * The load-bearing token shapes a summarizer must not drop: slash file paths
 * with an extension, uppercase identifier codes containing a digit or
 * underscore (error codes, env keys — bare acronyms like `API` don't count),
 * and version strings. Ordered by appearance so a capped list keeps the
 * earliest (usually headline) anchors.
 */
const ANCHOR_PATTERNS = [
  /\bv?\d+\.\d+(?:\.\d+)+\b/g,
  /\b[\w-]+(?:\/[\w.-]+)*\/[\w-]+\.\w{1,8}\b/g,
  /\b[A-Z][A-Z0-9]*[_0-9][A-Z0-9_]*\b/g,
];

/**
 * Extract up to `limit` distinctive anchors from original text, deduplicated,
 * in order of first appearance. The runtime survival floor checks these against
 * the compressed text; an empty result means the text has no mechanically
 * recognizable load-bearing tokens (survival is then vacuous). Pure.
 */
export function extractAnchors(text: string, limit = 12): string[] {
  const found: { index: number; value: string }[] = [];
  for (const pattern of ANCHOR_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      found.push({ index: m.index ?? 0, value: m[0] });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const anchors: string[] = [];
  for (const f of found) {
    if (anchors.length >= limit) break;
    if (!anchors.includes(f.value)) anchors.push(f.value);
  }
  return anchors;
}

/** One-line human summary of a survival assessment for eval output. Pure. */
export function formatFactSurvival(s: FactSurvival): string {
  const pct = Math.round(s.survivalRate * 100);
  return `fact survival: ${s.survived}/${s.total} buried facts survived (${pct}%)`;
}
