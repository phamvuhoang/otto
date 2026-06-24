/**
 * Report-legibility rubric (issue #64 P9, slice 3 — "report-legibility rubric
 * + eval signal").
 *
 * A pure scorer over a quality-report markdown document: it checks the document
 * against the structural criteria of the P9 layperson-first contract shape
 * (quality-report.md) and reports per-criterion results, a met-count / max
 * score, a 0..1 legibility ratio, and what is missing. It is the measurement
 * substrate for the P9 success metric ("% of reports a non-engineer understood
 * without reading code").
 *
 * Sibling to `plan-rubric.ts` (which scores a spec/plan document) and to
 * `eval.ts`'s `scoreTrajectory` (which scores a run trajectory). INERT on the
 * loop — nothing here runs a stage or changes behaviour; it only describes text.
 *
 * The detectors are deterministic header/keyword heuristics (no tokenizer, no
 * model call): the rubric judges *structural legibility* (does the report have
 * the layperson sections the P9 contract requires), the orthogonal question to
 * the *semantic* quality a human judges at review. Heuristic and labelled as
 * such, mirroring plan-rubric.ts's discipline.
 */

export type ReportCriterion =
  | "verdict"
  | "whatYouCanNowDo"
  | "why"
  | "howToVerify"
  | "whatToWatch"
  | "uncertainty"
  | "engineerDivider";

type CriterionDef = {
  criterion: ReportCriterion;
  /** Human-readable label for the scorecard. */
  label: string;
  /** Pure predicate: does the document satisfy this criterion? */
  detect: (doc: string) => boolean;
};

/**
 * The rubric criteria, in scorecard order. Each detector keys off the proven
 * P9 quality-report shape: a section header or the characteristic
 * keywords/markup of that section. Order is fixed so the scorecard and the
 * `missing` list are stable.
 */
export const REPORT_CRITERIA: ReadonlyArray<CriterionDef> = [
  {
    criterion: "verdict",
    label: "Verdict section",
    detect: (d) => /(?:^|\n)#{1,6}\s+Verdict\b/i.test(d),
  },
  {
    criterion: "whatYouCanNowDo",
    label: "What You Can Now Do section",
    detect: (d) => /(?:^|\n)#{1,6}\s+What You Can Now Do\b/i.test(d),
  },
  {
    criterion: "why",
    label: "Why section",
    detect: (d) => /(?:^|\n)#{1,6}\s+Why\b/i.test(d),
  },
  {
    criterion: "howToVerify",
    label: "How To Verify section with numbered step",
    detect: (d) => {
      // Require BOTH the section heading AND at least one numbered step after it.
      const headingMatch = /(?:^|\n)(#{1,6}\s+How To Verify\b)/i.exec(d);
      if (!headingMatch) return false;
      const afterHeading = d.slice(headingMatch.index + headingMatch[0].length);
      return /^\s*\d+\./m.test(afterHeading);
    },
  },
  {
    criterion: "whatToWatch",
    label: "What To Watch section",
    detect: (d) => /(?:^|\n)#{1,6}\s+What To Watch\b/i.test(d),
  },
  {
    criterion: "uncertainty",
    label: "What I Was Unsure About section",
    detect: (d) => /(?:^|\n)#{1,6}\s+What I Was Unsure About\b/i.test(d),
  },
  {
    criterion: "engineerDivider",
    label: "Engineer detail divider",
    detect: (d) => /Engineer detail below/i.test(d),
  },
];

export type ReportCriterionResult = {
  criterion: ReportCriterion;
  label: string;
  met: boolean;
};

export type ReportRubricScore = {
  /** Per-criterion outcome, in fixed scorecard order. */
  results: ReportCriterionResult[];
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
 * Score a quality-report markdown document against {@link REPORT_CRITERIA}.
 * Pure and deterministic — pass the full report text. Each criterion
 * contributes equally; the per-criterion breakdown lets a consumer reweight
 * later without changing the scorer.
 */
export function scoreReportLegibility(doc: string): ReportRubricScore {
  const results: ReportCriterionResult[] = REPORT_CRITERIA.map((c) => ({
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
 * Render a rubric score as a short, human-readable scorecard: a header with
 * the met/total and percentage, a checked/unchecked line per criterion, and a
 * one-line "missing" note when the report is incomplete.
 */
export function formatReportRubric(score: ReportRubricScore): string {
  const header =
    `report legibility: ${score.metCount}/${score.maxScore} ` +
    `(${pct.format(score.ratio * 100)}%)`;
  const lines = score.results.map((r) => `  [${r.met ? "x" : " "}] ${r.label}`);
  const tail =
    score.missing.length > 0 ? [`  missing: ${score.missing.join(", ")}`] : [];
  return [header, ...lines, ...tail].join("\n");
}
