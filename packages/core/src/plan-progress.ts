/**
 * Plan-checklist progress parser (P10, slice 1).
 *
 * A pure, deterministic parser over a markdown document: it counts GitHub
 * task-list checkboxes and reports how many are checked vs total. Used by later
 * P10 slices to render a live plan progress indicator.
 *
 * Sibling to `plan-rubric.ts` (a pure scorer over plan structure) — same
 * discipline: no I/O, no mutation, never throws, absent/malformed input yields
 * a safe zero-state result.
 *
 * Lines matched: `^\s*[-*]\s+\[( |x|X)\]\s+(.*)$` (multiline). The leading
 * `\s*[-*]\s+` anchor means a `[ ]` appearing mid-sentence is never counted.
 */

/** A single task-list item extracted from the plan markdown. */
export type PlanProgressItem = {
  text: string;
  done: boolean;
};

/** Parsed result of a GitHub task-list checklist in a plan markdown. */
export type PlanProgress = {
  /** Number of checked items (`[x]` or `[X]`). */
  checked: number;
  /** Total number of checkbox items (checked + unchecked). */
  total: number;
  /** Individual items in document order. */
  items: PlanProgressItem[];
};

const CHECKBOX_LINE_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/gm;

/**
 * Parse GitHub task-list checkboxes from a plan markdown document.
 *
 * Pure and deterministic — pass any string (including empty or garbage); the
 * result is always a valid {@link PlanProgress}. Never throws.
 */
export function parsePlanProgress(md: string): PlanProgress {
  if (typeof md !== "string" || md.length === 0)
    return { checked: 0, total: 0, items: [] };

  const items: PlanProgressItem[] = [];
  let checked = 0;

  // Reset lastIndex in case the module-level regex was left in a mid-match
  // state (defensive; shouldn't happen with /gm exec pattern below).
  CHECKBOX_LINE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = CHECKBOX_LINE_RE.exec(md)) !== null) {
    const boxChar = match[1]; // " ", "x", or "X"
    const text = match[2].trimEnd();
    const done = boxChar === "x" || boxChar === "X";
    if (done) checked++;
    items.push({ text, done });
  }

  if (items.length === 0) return { checked: 0, total: 0, items: [] };
  return { checked, total: items.length, items };
}
