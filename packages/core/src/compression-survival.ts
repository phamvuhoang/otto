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
 * Pure and eval-only: it takes a known set of "buried facts" and the compressed
 * text and reports which facts still appear. It never runs a stage, mutates a
 * prompt, or touches the live compress path — the runtime compressor has no
 * facts list; survival can only be scored against facts an eval supplies.
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

/** One-line human summary of a survival assessment for eval output. Pure. */
export function formatFactSurvival(s: FactSurvival): string {
  const pct = Math.round(s.survivalRate * 100);
  return `fact survival: ${s.survived}/${s.total} buried facts survived (${pct}%)`;
}
