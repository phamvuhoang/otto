/**
 * P30 context budget enforcement — the governed degrade ladder.
 *
 * `context-budget.ts` has measured and recommended since P7 while nothing
 * acted. This applies the levers, in order, only when a stage's assembled
 * context is over budget and only under `--token-mode enforce`.
 *
 * Two properties do the safety work:
 *
 *  - **Task inputs and playbook text are never cut.** The ladder rewrites the
 *    contents of recognized filler blocks and nothing else.
 *  - **It verifies its own rewrite and fails closed.** This is textual surgery
 *    on a rendered prompt; a prompt that is over budget is a cost problem, but
 *    a prompt that has been silently mangled is a correctness problem.
 *
 * There is no truncation rung. Still over budget after every lever is recorded
 * as still-over and the prompt ships intact.
 *
 * Spec: `docs/superpowers/specs/2026-07-31-p30-budget-enforcement-design.md`.
 */
import {
  assessContextBudget,
  type ContextBudgetAssessment,
} from "./context-budget.js";
import { analyzeContext, estimateTokens } from "./context-report.js";
import {
  compactCommits,
  formatCompactedCommits,
  parseCommitLog,
} from "./iteration-compaction.js";

export type ContextEnforcementLever =
  | "bound-learnings"
  | "compress-spill"
  | "compact-commits";

export type ContextEnforcementEvent = {
  lever: ContextEnforcementLever;
  beforeTokens: number;
  afterTokens: number;
  stage: string;
  /** Present when the lever did not apply: why. Absent ⇒ it was applied. */
  skipped?: "lever-unavailable" | "no-effect" | "invariant-violation";
};

export type EnforcementHooks = {
  /** Re-render `<learnings>` under a tighter budget. Absent ⇒ lever skipped. */
  renderBoundedLearnings?: (budgetChars: number) => string | null;
  /** Compress one evidence block's text. Absent ⇒ lever skipped. Only ever
   *  called for categories policy already authorizes (P29 D6 / P22 #200). */
  compressEvidence?: (tag: string, text: string) => string | null;
};

export type EnforcementSummary = {
  applications: number;
  tokensSaved: number;
  byLever: Partial<Record<ContextEnforcementLever, number>>;
};

/** Char ceiling for the accretive resume-note chain, mirroring the skills
 *  block's `DEFAULT_SKILLS_BUDGET_CHARS` budget pattern. */
export const RESUME_NOTE_MAX_CHARS = 2000;

/**
 * Bound the resume note by dropping whole sections, lowest-value first.
 *
 * NOT head-preserving. `loop.ts` composes the plan-gate note as
 * `[lead, formatPlanGate, formatPlanDepthRubric, "Rewrite <spec> and <plan>…"]`
 * joined by blank lines — the **actionable instruction is last** and the two
 * rubric renderings in the middle are the bulky part. Truncating from the head
 * would cut precisely the sentence telling the agent which files to rewrite,
 * leaving a diagnosis with nothing to act on.
 *
 * So the last section is never dropped, the first is dropped only as a last
 * resort, and the middle goes first. Pure.
 */
export function boundResumeNote(
  note: string,
  maxChars: number = RESUME_NOTE_MAX_CHARS
): string {
  if (note.length <= maxChars) return note;
  const sections = note.split("\n\n").filter((s) => s.trim().length > 0);
  if (sections.length <= 1) return note; // nothing to drop; never mid-cut
  const NOTE = (n: number): string =>
    `\n\n_${n} section(s) of this note omitted to fit the ${maxChars}-char budget._`;

  // Drop order: middle sections (bulky diagnostics) from the end inward, then
  // the lead. The final section — the instruction — is never a candidate.
  const dropOrder: number[] = [];
  for (let i = sections.length - 2; i >= 1; i--) dropOrder.push(i);
  dropOrder.push(0);

  const dropped = new Set<number>();
  for (const idx of dropOrder) {
    const kept = sections.filter((_, i) => !dropped.has(i));
    if (kept.join("\n\n").length + NOTE(dropped.size).length <= maxChars) break;
    dropped.add(idx);
  }
  const kept = sections.filter((_, i) => !dropped.has(i));
  if (dropped.size === 0) return note;
  return `${kept.join("\n\n")}${NOTE(dropped.size)}`;
}

/** Block tags the ladder may rewrite, by lever. Never `inputs`, never playbook. */
const LEARNINGS_BLOCK = /(<learnings>\n)([\s\S]*?)(\n<\/learnings>)/;
const COMMITS_BLOCK = /(<commits>\n)([\s\S]*?)(\n<\/commits>)/;
const EVIDENCE_BLOCKS = [
  "issue",
  "issues-summary",
  "issues-full-file",
  "graph-map",
];

/** Char footprint of the categories enforcement must never touch. */
function protectedFootprint(prompt: string): {
  inputs: number;
  playbook: number;
} {
  const b = analyzeContext(prompt);
  const at = (c: string): number =>
    b.segments.find((s) => s.category === c)?.chars ?? 0;
  return { inputs: at("inputs"), playbook: at("playbook") };
}

/**
 * The self-verification (spec D2). A rewrite is accepted only if it left the
 * task inputs and the playbook untouched and preserved every recognized block
 * tag — the ladder rewrites *contents*, never structure.
 */
function rewriteIsSafe(before: string, after: string): boolean {
  const p0 = protectedFootprint(before);
  const p1 = protectedFootprint(after);
  if (p0.inputs !== p1.inputs || p0.playbook !== p1.playbook) return false;
  for (const tag of ["learnings", "commits", "inputs", ...EVIDENCE_BLOCKS]) {
    const open = `<${tag}>`;
    if (before.includes(open) && !after.includes(open)) return false;
  }
  return true;
}

export function summarizeEnforcement(
  events: ContextEnforcementEvent[]
): EnforcementSummary {
  const applied = events.filter((e) => e.skipped === undefined);
  const byLever: Partial<Record<ContextEnforcementLever, number>> = {};
  let tokensSaved = 0;
  for (const e of applied) {
    const saved = e.beforeTokens - e.afterTokens;
    tokensSaved += saved;
    byLever[e.lever] = (byLever[e.lever] ?? 0) + saved;
  }
  return { applications: applied.length, tokensSaved, byLever };
}

/**
 * Walk the degrade ladder until the prompt fits, or every lever is spent.
 *
 * Levers apply in cheapest-first order and the ladder stops as soon as the
 * prompt is within budget, so a mildly over-budget stage pays for one lever
 * rather than all three.
 */
export function enforceContextBudget(
  prompt: string,
  ctx: {
    stage: string;
    model?: string;
    maxTokens?: number;
    fraction?: number;
    learningsBudgetChars?: number;
    commitsBudgetChars?: number;
    hooks?: EnforcementHooks;
  }
): {
  prompt: string;
  events: ContextEnforcementEvent[];
  assessment: ContextBudgetAssessment;
} {
  const budgetOpts = {
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    ...(ctx.maxTokens !== undefined ? { maxTokens: ctx.maxTokens } : {}),
    ...(ctx.fraction !== undefined ? { fraction: ctx.fraction } : {}),
  };
  const assess = (p: string): ContextBudgetAssessment =>
    assessContextBudget(analyzeContext(p), budgetOpts);

  let current = prompt;
  let assessment = assess(current);
  const events: ContextEnforcementEvent[] = [];
  if (!assessment.overBudget) return { prompt: current, events, assessment };

  const hooks = ctx.hooks ?? {};

  const attempt = (
    lever: ContextEnforcementLever,
    rewrite: () => string | null
  ): void => {
    if (!assessment.overBudget) return;
    const beforeTokens = assessment.estimatedTokens;
    let next: string | null;
    try {
      next = rewrite();
    } catch {
      next = null;
    }
    if (next == null) {
      events.push({
        lever,
        beforeTokens,
        afterTokens: beforeTokens,
        stage: ctx.stage,
        skipped: "lever-unavailable",
      });
      return;
    }
    if (next.length >= current.length) {
      events.push({
        lever,
        beforeTokens,
        afterTokens: beforeTokens,
        stage: ctx.stage,
        skipped: "no-effect",
      });
      return;
    }
    if (!rewriteIsSafe(current, next)) {
      // Fail closed: ship the original. An over-budget prompt costs money; a
      // mangled one costs correctness.
      events.push({
        lever,
        beforeTokens,
        afterTokens: beforeTokens,
        stage: ctx.stage,
        skipped: "invariant-violation",
      });
      return;
    }
    current = next;
    assessment = assess(current);
    events.push({
      lever,
      beforeTokens,
      afterTokens: assessment.estimatedTokens,
      stage: ctx.stage,
    });
  };

  // 1. Tighter bounded learnings — cheapest, and the block most often bloated.
  attempt("bound-learnings", () => {
    if (!hooks.renderBoundedLearnings) return null;
    const m = LEARNINGS_BLOCK.exec(current);
    if (!m) return null;
    const replacement = hooks.renderBoundedLearnings(
      ctx.learningsBudgetChars ?? 2000
    );
    if (replacement == null) return null;
    return current.replace(LEARNINGS_BLOCK, `$1${replacement}$3`);
  });

  // 2. Reversible evidence compression — only categories policy authorizes.
  attempt("compress-spill", () => {
    if (!hooks.compressEvidence) return null;
    let next = current;
    let changed = false;
    for (const tag of EVIDENCE_BLOCKS) {
      const re = new RegExp(`(<${tag}>\\n)([\\s\\S]*?)(\\n</${tag}>)`);
      const m = re.exec(next);
      if (!m) continue;
      const out = hooks.compressEvidence(tag, m[2]);
      if (out == null || out.length >= m[2].length) continue;
      next = next.replace(re, `$1${out}$3`);
      changed = true;
    }
    return changed ? next : null;
  });

  // 3. Commit compaction — older bodies degrade to subjects.
  attempt("compact-commits", () => {
    const m = COMMITS_BLOCK.exec(current);
    if (!m) return null;
    const entries = parseCommitLog(m[2]);
    if (entries.length === 0) return null;
    const compacted = compactCommits(entries, {
      ...(ctx.commitsBudgetChars !== undefined
        ? { maxChars: ctx.commitsBudgetChars }
        : {}),
    });
    if (compacted.compacted.length === 0) return null;
    return current.replace(
      COMMITS_BLOCK,
      `$1${formatCompactedCommits(compacted)}$3`
    );
  });

  return { prompt: current, events, assessment };
}

/** Re-exported so callers can size a budget without importing context-report. */
export { estimateTokens };
