/**
 * Context telemetry (issue #62 P7, slice 1 — "measure before optimizing").
 *
 * A pure analyzer over a *rendered* stage prompt: it attributes the inline
 * window footprint to the sections that actually fill it, so a later P7 slice
 * (prefix caching, bounded learnings, compaction, read-dedup, budget) can prove
 * it shrank the right thing. INERT on the loop — nothing here runs a stage or
 * changes behavior; it only describes a string.
 *
 * Token counts are an estimate (`ceil(chars/4)`), labelled as such. The
 * authoritative per-stage usage comes from the provider via `tokens.ts`; this
 * module answers the orthogonal *composition* question ("which section is the
 * prompt made of") that a single usage total cannot.
 */

import {
  classifyLifecycle,
  type ContextLifecycle,
} from "./context-lifecycle.js";

export type ContextCategory = "commits" | "learnings" | "inputs" | "playbook";

export type ContextSegment = {
  category: ContextCategory;
  chars: number;
  estimatedTokens: number;
  /**
   * The orthogonal lifecycle class derived from `category` (see
   * `context-lifecycle.ts`) — *why* the segment is still in the window and
   * whether it could be freed. Optional so older serialized breakdowns parse.
   */
  lifecycle?: ContextLifecycle;
};

export type ContextBreakdown = {
  totalChars: number;
  estimatedTokens: number;
  /** Per-category footprint, sorted by chars descending; empty categories omitted. */
  segments: ContextSegment[];
};

/** Standard rough token estimate: ~4 chars per token, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Top-level rendered-prompt block tags → the category they fill. These markers
 * are stable across the afk / ghafk / ghafk-issue templates (see
 * `templates/{afk,ghafk,ghafk-issue}.md`). Anything outside a recognized block
 * is the workflow instructions, attributed to `playbook`.
 */
const BLOCK_CATEGORY: Record<string, ContextCategory> = {
  commits: "commits",
  learnings: "learnings",
  inputs: "inputs",
  issue: "inputs",
  "issues-summary": "inputs",
  "issues-full-file": "inputs",
};

/** Sum the char footprint of every recognized `<tag>…</tag>` span, by category. */
function recognizedSpans(prompt: string): Map<ContextCategory, number> {
  const byCategory = new Map<ContextCategory, number>();
  for (const [tag, category] of Object.entries(BLOCK_CATEGORY)) {
    // Non-greedy, dot-all: each top-level block appears at most once per prompt.
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
    for (const match of prompt.matchAll(re)) {
      byCategory.set(category, (byCategory.get(category) ?? 0) + match[0].length);
    }
  }
  return byCategory;
}

/**
 * Segment a rendered stage prompt into its context categories. The category
 * char counts sum to the whole prompt: recognized blocks are attributed to
 * their category, all remaining text falls to `playbook`.
 */
export function analyzeContext(prompt: string): ContextBreakdown {
  const totalChars = prompt.length;
  const byCategory = recognizedSpans(prompt);

  const recognizedTotal = [...byCategory.values()].reduce((a, b) => a + b, 0);
  const playbook = totalChars - recognizedTotal;
  if (playbook > 0) {
    byCategory.set("playbook", playbook);
  }

  const segments: ContextSegment[] = [...byCategory.entries()]
    .filter(([, chars]) => chars > 0)
    .map(([category, chars]) => ({
      category,
      chars,
      estimatedTokens: estimateTokens(chars),
      lifecycle: classifyLifecycle(category),
    }))
    .sort((a, b) => b.chars - a.chars);

  return {
    totalChars,
    estimatedTokens: estimateTokens(totalChars),
    segments,
  };
}

const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US");

/**
 * Render a breakdown as a short, human-readable composition report. The `~`
 * prefix marks the token figures as estimates, not authoritative billing.
 */
export function formatContextReport(b: ContextBreakdown): string {
  const header = `context: ${num.format(b.totalChars)} chars (~${num.format(
    b.estimatedTokens
  )} tokens)`;
  if (b.segments.length === 0) return header;

  const lines = b.segments.map((s) => {
    const share = b.totalChars > 0 ? (s.chars / b.totalChars) * 100 : 0;
    return `  ${s.category.padEnd(10)} ${num.format(s.chars)} chars (~${num.format(
      s.estimatedTokens
    )} tokens)  ${pct.format(share)}%`;
  });
  return [header, ...lines].join("\n");
}
