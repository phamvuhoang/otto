/**
 * Context lifecycle taxonomy (issue #66 P11, slice T1 — "name what is freeable").
 *
 * A pure, orthogonal axis derived from the existing `ContextCategory`
 * (`context-report.ts`): where category answers *which section* the prompt is
 * made of, lifecycle answers *why it is still in the window and whether it could
 * be freed*. Modelled on the governed-memory design where `trust`/`confidence`/
 * `status` are kept as separate orthogonal axes — lifecycle does not replace
 * category, it is computed from it.
 *
 * INERT on the loop — nothing here runs a stage or mutates a prompt; it only
 * classifies and rolls up an already-measured `ContextBreakdown`.
 */

import {
  type ContextBreakdown,
  type ContextCategory,
} from "./context-report.js";

/**
 * The four roadmap lifecycle classes (`docs/HARNESS_ROADMAP_PHASE5.md` P22):
 *
 * - `required-now` — stage contract, current task, active diff. Must stay.
 * - `resolved` — previous-iteration discussion / completed subtasks. Retirable.
 * - `durable` — governed memory and final decisions. Kept, but compactable.
 * - `retrievable` — logs, issue bodies, command output, screenshots. No distinct
 *   category emits this yet (finer `inputs` segmentation is a later slice), so it
 *   is part of the taxonomy but not produced by `classifyLifecycle` today.
 */
export type ContextLifecycle =
  | "required-now"
  | "resolved"
  | "durable"
  | "retrievable";

/**
 * Total mapping from a context category to its lifecycle class. Pure and
 * exhaustive over every `ContextCategory`:
 *
 * - `playbook` / `inputs` → `required-now`
 * - `commits` → `resolved`
 * - `learnings` → `durable`
 */
export function classifyLifecycle(category: ContextCategory): ContextLifecycle {
  switch (category) {
    case "playbook":
    case "inputs":
      return "required-now";
    case "commits":
      return "resolved";
    case "learnings":
      return "durable";
  }
}

export type LifecycleTotals = {
  lifecycle: ContextLifecycle;
  chars: number;
  estimatedTokens: number;
};

export type LifecycleSummary = {
  totalChars: number;
  estimatedTokens: number;
  /** Per-lifecycle footprint, sorted by chars descending; empty classes omitted. */
  byLifecycle: LifecycleTotals[];
};

/**
 * Roll a measured `ContextBreakdown` up by lifecycle class. Char totals partition
 * the prompt exactly (every segment maps to one lifecycle); token totals sum the
 * per-segment estimates so the rollup is rounding-stable against the breakdown's
 * own segment tokens.
 */
export function summarizeLifecycle(breakdown: ContextBreakdown): LifecycleSummary {
  const byLifecycle = new Map<ContextLifecycle, LifecycleTotals>();
  for (const segment of breakdown.segments) {
    const lifecycle = classifyLifecycle(segment.category);
    const entry = byLifecycle.get(lifecycle) ?? {
      lifecycle,
      chars: 0,
      estimatedTokens: 0,
    };
    entry.chars += segment.chars;
    entry.estimatedTokens += segment.estimatedTokens;
    byLifecycle.set(lifecycle, entry);
  }

  const totals = [...byLifecycle.values()].sort((a, b) => b.chars - a.chars);
  return {
    totalChars: totals.reduce((a, b) => a + b.chars, 0),
    estimatedTokens: totals.reduce((a, b) => a + b.estimatedTokens, 0),
    byLifecycle: totals,
  };
}
