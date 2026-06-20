/**
 * Per-stage context budget (issue #62 P7, slice 8 — the final P7 substrate).
 *
 * A soft, model-aware ceiling on the *inline rendered prompt*: it compares a
 * stage's estimated context footprint (slice 1's {@link ContextBreakdown}) to a
 * fraction of the active model's context window, and — when the prompt exceeds
 * the ceiling — recommends which compaction lever to pull. The recommendation
 * points at the largest *reducible* filler: the commits block (slice 6's
 * `compactCommits`) or the learnings block (slice 5's `boundLearnings`); the
 * task source (`inputs`) and the workflow `playbook` are not P7-reducible.
 *
 * Soft, not a gate: exceeding the budget warns and recommends; it never blocks a
 * run. Pure + INERT on the loop — nothing here runs a stage, renders a prompt,
 * or compacts anything. Wiring this assessment into the loop (warn + trigger the
 * slice-5/6 levers when over budget) is a later slice; this is the measurement
 * substrate, mirroring how slices 1 and 4–7 shipped pure-then-wired.
 */

import type { ContextBreakdown, ContextCategory } from "./context-report.js";

/**
 * Known model context windows (tokens), matched by a lowercased substring of the
 * model spec. Otto passes the spec opaquely to the CLI (see `resolveModelArgs`),
 * so specs vary ("claude-opus-4-8", "sonnet", aliases); we match loosely and the
 * 1M-context marker wins over the family default. Order matters: most specific
 * (the 1M markers) first.
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["[1m]", 1_000_000],
  ["-1m", 1_000_000],
  ["opus", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
];

/** Conservative window for an unrecognized or unset model spec. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Fraction of the model window the inline rendered prompt should stay under,
 * leaving headroom for the agent's own tool reads and generated output. The
 * ceiling is soft: crossing it warns and recommends compaction, never blocks.
 */
export const DEFAULT_CONTEXT_BUDGET_FRACTION = 0.25;

/** The model's total context window in tokens (loose match; default on miss). */
export function modelContextWindow(model: string | undefined): number {
  const spec = (model ?? "").toLowerCase();
  if (spec !== "") {
    for (const [needle, window] of MODEL_CONTEXT_WINDOWS) {
      if (spec.includes(needle)) return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** The soft inline-prompt budget: a fraction of the model's context window. */
export function modelContextBudget(
  model: string | undefined,
  fraction: number = DEFAULT_CONTEXT_BUDGET_FRACTION
): number {
  return Math.round(modelContextWindow(model) * fraction);
}

/** Categories a P7 lever can shrink, mapped to the lever that does it. */
const REDUCIBLE_LEVERS: Partial<Record<ContextCategory, string>> = {
  commits: "inter-iteration commit compaction (compactCommits, slice 6)",
  learnings: "bounded learnings injection (boundLearnings, slice 5)",
};

/** What to compact when a stage is over budget — the largest reducible filler. */
export type BudgetRecommendation = {
  category: ContextCategory;
  /** Chars that category currently occupies in the rendered prompt. */
  chars: number;
  /** The P7 lever that shrinks it. */
  lever: string;
};

export type ContextBudgetAssessment = {
  /** Estimated tokens of the rendered prompt (from the breakdown). */
  estimatedTokens: number;
  /** The soft ceiling applied (explicit `maxTokens` or model-derived). */
  budgetTokens: number;
  /** The model's full context window the budget is a fraction of. */
  windowTokens: number;
  overBudget: boolean;
  /** Tokens over the budget; 0 when within budget. */
  overByTokens: number;
  /** Tokens of headroom left; 0 when over budget. */
  headroomTokens: number;
  /** estimatedTokens / budgetTokens; 0 when the budget is 0. */
  ratio: number;
  /** Present only when over budget AND a reducible category exists to compact. */
  recommendation?: BudgetRecommendation;
};

/** Inputs that drive a context-budget assessment (issue #62 P7 slice 8). */
export type ContextBudgetContext = {
  /** Active model spec; selects the window. Ignored when `maxTokens` is set. */
  model?: string;
  /** Explicit token ceiling; overrides the model-derived budget. */
  maxTokens?: number;
  /** Fraction of the window for the model-derived budget; default 0.25. */
  fraction?: number;
};

/**
 * Assess a stage's rendered-prompt footprint against the soft, model-aware
 * budget, and — when over — recommend compacting the largest reducible filler
 * (commits/learnings). Pure: takes the breakdown, returns the verdict; triggers
 * nothing. The "warn + trigger compaction" wiring is a later slice.
 */
export function assessContextBudget(
  breakdown: ContextBreakdown,
  ctx: ContextBudgetContext = {}
): ContextBudgetAssessment {
  const windowTokens = modelContextWindow(ctx.model);
  const budgetTokens =
    ctx.maxTokens ?? modelContextBudget(ctx.model, ctx.fraction);
  const estimatedTokens = breakdown.estimatedTokens;
  const overBudget = estimatedTokens > budgetTokens;

  let recommendation: BudgetRecommendation | undefined;
  if (overBudget) {
    // Segments arrive sorted by chars descending (analyzeContext), so the first
    // reducible one is the largest filler a P7 lever can shrink.
    const top = breakdown.segments.find((s) => s.category in REDUCIBLE_LEVERS);
    if (top) {
      recommendation = {
        category: top.category,
        chars: top.chars,
        lever: REDUCIBLE_LEVERS[top.category]!,
      };
    }
  }

  return {
    estimatedTokens,
    budgetTokens,
    windowTokens,
    overBudget,
    overByTokens: Math.max(0, estimatedTokens - budgetTokens),
    headroomTokens: Math.max(0, budgetTokens - estimatedTokens),
    ratio: budgetTokens > 0 ? estimatedTokens / budgetTokens : 0,
    recommendation,
  };
}

const num = new Intl.NumberFormat("en-US");
const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Render a budget assessment as a short, human-readable line. The `~` prefix
 * marks the estimated-token figures (the budget itself is exact). When over
 * budget with a reducible filler, the line names the category and lever to pull.
 */
export function formatContextBudget(a: ContextBudgetAssessment): string {
  const head =
    `context budget: ~${num.format(a.estimatedTokens)} tokens / ` +
    `${num.format(a.budgetTokens)} budget ` +
    `(${pct.format(a.ratio * 100)}% of budget, ` +
    `${num.format(a.windowTokens)}-token window)`;
  if (!a.overBudget) return `${head} — within budget`;
  const tail = a.recommendation
    ? ` — compact ${a.recommendation.category} via ${a.recommendation.lever}`
    : " — no P7-reducible filler to compact (inputs/playbook dominate)";
  return `${head} — EXCEEDS by ${num.format(a.overByTokens)} tokens${tail}`;
}
