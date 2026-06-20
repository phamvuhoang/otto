/**
 * Plan-quality rubric (issue #63 P8, slice 1 — "measure plan quality before
 * generating plans").
 *
 * A pure scorer over a spec/plan markdown document: it checks the document
 * against the structural criteria of a world-class plan (the proven
 * `docs/superpowers` + issue-62 shape) and reports per-criterion results, a
 * met-count / max score, a 0..1 completeness ratio, and what is missing. It is
 * the measurement substrate every later P8 slice reads — the `plan` stage,
 * its eval signal ("plan-completeness rubric score ↑ across fixtures"), the
 * `--plan-report` surface, and the human checkpoint.
 *
 * Sibling to `eval.ts`'s `scoreTrajectory` (a pure scorer over recorded data),
 * but scoring a *document* rather than a run trajectory. INERT on the loop —
 * nothing here runs a stage or changes behavior; it only describes text.
 *
 * The detectors are deterministic header/keyword heuristics (no tokenizer, no
 * model call): the rubric judges *structural completeness* (does the plan have
 * the sections a good plan has), the orthogonal question to the *semantic*
 * quality a human/model judges at the checkpoint. Heuristic and labelled as
 * such, mirroring P7's `ceil(chars/4)` estimate discipline.
 */

export type PlanCriterion =
  | "problem"
  | "decisions"
  | "scopeGuard"
  | "fileMap"
  | "taskBreakdown"
  | "testFirst"
  | "verifyCommands"
  | "successCriteria";

type CriterionDef = {
  criterion: PlanCriterion;
  /** Human-readable label for the scorecard. */
  label: string;
  /** Pure predicate: does the document satisfy this criterion? */
  detect: (doc: string) => boolean;
};

/** Count non-overlapping matches of a global regex in the document. */
function count(doc: string, re: RegExp): number {
  return (doc.match(re) ?? []).length;
}

// Path-like inline code: a backticked token with a path separator or a known
// source-file extension — the signal a plan names the files it will touch.
const PATH_TOKEN_RE =
  /`[^`\n]*(?:\/[^`\n]*|\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|py|go|rs|java|rb|sh))`/gi;
// Task list items: markdown checkboxes or top-of-line ordered items.
const CHECKBOX_RE = /(?:^|\n)\s*[-*]\s*\[[ xX]\]/g;
const ORDERED_ITEM_RE = /(?:^|\n)\s*\d+\.\s+\S/g;

/**
 * The rubric criteria, in scorecard order. Each detector keys off the proven
 * plan shape: a section header or the characteristic keywords/markup of that
 * section. Order is fixed so the scorecard and the `missing` list are stable.
 */
export const PLAN_CRITERIA: ReadonlyArray<CriterionDef> = [
  {
    criterion: "problem",
    label: "Problem statement",
    detect: (d) => /(?:^|\n)#{1,6}\s+[^\n]*\bproblem\b/i.test(d),
  },
  {
    criterion: "decisions",
    label: "Decisions / assumptions",
    detect: (d) => /\b(?:assumptions?|decisions?|rationale)\b/i.test(d),
  },
  {
    criterion: "scopeGuard",
    label: "Scope guard / non-goals",
    detect: (d) =>
      /\b(?:scope guard|non-?goals?|out of scope|not in scope|won'?t (?:do|build|change|ship))\b/i.test(
        d
      ),
  },
  {
    criterion: "fileMap",
    label: "File / component map",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:file (?:map|structure)|component map|files)\b/i.test(
        d
      ) || count(d, PATH_TOKEN_RE) >= 2,
  },
  {
    criterion: "taskBreakdown",
    label: "Task breakdown",
    detect: (d) =>
      count(d, CHECKBOX_RE) >= 2 ||
      count(d, ORDERED_ITEM_RE) >= 2 ||
      count(d, /(?:^|\n)#{1,6}\s+task\b/gi) >= 2,
  },
  {
    criterion: "testFirst",
    label: "Failing-test-first (TDD)",
    detect: (d) =>
      /\b(?:failing test|test[- ]first|tdd|red[- ]green|write (?:a |the )?(?:failing )?test|tests? (?:first|before)|pinned by)\b/i.test(
        d
      ),
  },
  {
    criterion: "verifyCommands",
    label: "Explicit verify commands",
    detect: (d) =>
      /\bverify:/i.test(d) ||
      (/\bverif(?:y|ied|ication)\b/i.test(d) &&
        /\b(?:pnpm|npm run|vitest|tsc|node --test|node --|pytest|go test|cargo test|make)\b/i.test(
          d
        )),
  },
  {
    criterion: "successCriteria",
    label: "Testable success criteria",
    detect: (d) =>
      /\b(?:success (?:criteria|metric)|acceptance (?:criteria|checklist|test)|done when|testing notes|testable)\b/i.test(
        d
      ),
  },
];

export type PlanCriterionResult = {
  criterion: PlanCriterion;
  label: string;
  met: boolean;
};

export type PlanRubricScore = {
  /** Per-criterion outcome, in fixed scorecard order. */
  results: PlanCriterionResult[];
  /** Criteria met. */
  metCount: number;
  /** Total criteria (the denominator). */
  maxScore: number;
  /** metCount / maxScore in 0..1; 0 when there are no criteria. */
  ratio: number;
  /** Labels of unmet criteria — the "what to improve" surface. */
  missing: string[];
};

/**
 * Score a spec/plan markdown document against {@link PLAN_CRITERIA}. Pure and
 * deterministic — pass the spec text, the plan text, or both concatenated. Each
 * criterion contributes equally; the per-criterion breakdown lets a consumer
 * reweight later without changing the scorer.
 */
export function scorePlanQuality(doc: string): PlanRubricScore {
  const results: PlanCriterionResult[] = PLAN_CRITERIA.map((c) => ({
    criterion: c.criterion,
    label: c.label,
    met: c.detect(doc),
  }));
  const metCount = results.reduce((n, r) => n + (r.met ? 1 : 0), 0);
  const maxScore = results.length;
  return {
    results,
    metCount,
    maxScore,
    ratio: maxScore > 0 ? metCount / maxScore : 0,
    missing: results.filter((r) => !r.met).map((r) => r.label),
  };
}

const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Render a rubric score as a short, human-readable scorecard: a header with the
 * met/total and percentage, a checked/unchecked line per criterion, and a
 * one-line "missing" note when the plan is incomplete.
 */
export function formatPlanRubric(score: PlanRubricScore): string {
  const header =
    `plan quality: ${score.metCount}/${score.maxScore} ` +
    `(${pct.format(score.ratio * 100)}%)`;
  const lines = score.results.map(
    (r) => `  [${r.met ? "x" : " "}] ${r.label}`
  );
  const tail =
    score.missing.length > 0 ? [`  missing: ${score.missing.join(", ")}`] : [];
  return [header, ...lines, ...tail].join("\n");
}
