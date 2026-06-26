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
 * - `retrievable` — logs, issue bodies, command output, screenshots. Produced by
 *   the `evidence` category (the ghafk issue-body tags); finer producers
 *   (command-output spills, screenshots) join the same category in later slices.
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
 * - `evidence` → `retrievable`
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
    case "evidence":
      return "retrievable";
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
export function summarizeLifecycle(
  breakdown: ContextBreakdown
): LifecycleSummary {
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

/**
 * What could be done to a freeable lifecycle class without losing information
 * the run still needs:
 *
 * - `retire` — settled prior-iteration discussion (`resolved`) can drop out of
 *   the window entirely; it is reconstructable from the commit log.
 * - `compress` — bulky reconstructable context (`retrievable`: logs, issue
 *   bodies, command output) can be summarized/spilled rather than dropped.
 */
export type FreeableAction = "retire" | "compress";

/** Lifecycle classes a dry-run report may name as freeable, and how. */
const FREEABLE_ACTIONS: Partial<Record<ContextLifecycle, FreeableAction>> = {
  resolved: "retire",
  retrievable: "compress",
};

export type FreeableSegment = {
  lifecycle: ContextLifecycle;
  action: FreeableAction;
  chars: number;
  estimatedTokens: number;
};

export type FreeableContextAssessment = {
  /** Chars that could be freed (retired + compressed); 0 when nothing is freeable. */
  freeableChars: number;
  /** Estimated tokens that could be freed; 0 when nothing is freeable. */
  freeableTokens: number;
  /** Per-lifecycle freeable footprint, sorted by tokens descending; empty omitted. */
  segments: FreeableSegment[];
};

/**
 * Dry-run "freeable context" recommendation: name the `resolved` context as
 * _retirable_ and the `retrievable` context as _compressible_, with estimated
 * token savings. `required-now` and `durable` are never freeable. Pure: returns
 * a recommendation, mutates nothing — retiring/compressing for real is a later
 * slice gated on this report being trusted. Token totals sum the per-segment
 * estimates so they are rounding-stable against the breakdown's own segments.
 */
export function assessFreeableContext(
  breakdown: ContextBreakdown
): FreeableContextAssessment {
  const byLifecycle = new Map<ContextLifecycle, FreeableSegment>();
  for (const segment of breakdown.segments) {
    const lifecycle = segment.lifecycle ?? classifyLifecycle(segment.category);
    const action = FREEABLE_ACTIONS[lifecycle];
    if (!action) continue;
    const entry = byLifecycle.get(lifecycle) ?? {
      lifecycle,
      action,
      chars: 0,
      estimatedTokens: 0,
    };
    entry.chars += segment.chars;
    entry.estimatedTokens += segment.estimatedTokens;
    byLifecycle.set(lifecycle, entry);
  }

  const segments = [...byLifecycle.values()].sort(
    (a, b) => b.estimatedTokens - a.estimatedTokens
  );
  return {
    freeableChars: segments.reduce((a, b) => a + b.chars, 0),
    freeableTokens: segments.reduce((a, b) => a + b.estimatedTokens, 0),
    segments,
  };
}

const num = new Intl.NumberFormat("en-US");

/**
 * Render a freeable-context assessment as a short, human-readable line. The `~`
 * prefix marks the estimated-token figure. Names each freeable class and its
 * action; falls back to an explicit "none" line when nothing is freeable.
 */
export function formatFreeableContext(a: FreeableContextAssessment): string {
  if (a.freeableTokens === 0) {
    return "freeable context: none — no resolved or retrievable context to free";
  }
  const parts = a.segments.map(
    (s) =>
      `${s.action} ${s.lifecycle} (~${num.format(s.estimatedTokens)} tokens)`
  );
  return (
    `freeable context: ~${num.format(a.freeableTokens)} tokens ` +
    `(${num.format(a.freeableChars)} chars) — ${parts.join(", ")}`
  );
}
