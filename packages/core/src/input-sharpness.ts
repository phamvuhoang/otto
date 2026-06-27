/**
 * Input-sharpness rubric (issue #180 P23, slice 1 — "measure the input before
 * sharpening it").
 *
 * A pure scorer over the *raw input* a run starts from — the plan/PRD file, the
 * GitHub issue body, or a one-line idea — the inverse of `plan-rubric.ts`, which
 * scores the *authored plan*. Where the plan rubric asks "does the output plan
 * have the sections a good plan has", this asks the upstream question: "does the
 * incoming request even state what it wants?". It reports which input dimensions
 * are present (problem, goal, constraints, success criteria, scope) and, by
 * negation, the **unknowns** a later sharpening pass must clarify with the
 * operator or — in AFK — record an explicit assumption for before planning.
 *
 * It is the measurement substrate every later P23 slice reads: the input
 * sharpening pass on the plan path (extract → ask high-value questions → record
 * assumptions in AFK → decision log), and that pass's eval signal ("plan depth
 * rises on vague-input fixtures"). INERT on the loop — nothing here runs a stage
 * or changes behavior; it only describes text.
 *
 * The detectors are deterministic keyword/header heuristics (no tokenizer, no
 * model call), labelled as such, mirroring `plan-rubric.ts`'s discipline: the
 * rubric judges *structural presence* of each dimension, the orthogonal question
 * to the *semantic* quality a model/human judges when actually sharpening.
 */

export type InputDimension =
  | "problem"
  | "goal"
  | "constraints"
  | "successCriteria"
  | "scope";

type DimensionDef = {
  dimension: InputDimension;
  /** Human-readable label for the scorecard + the unknowns list. */
  label: string;
  /** Pure predicate: does the input state this dimension? */
  detect: (input: string) => boolean;
};

/**
 * The input dimensions, in scorecard order. Each detector keys off a section
 * header or the characteristic phrasing of that dimension. Order is fixed so the
 * scorecard and the `unknowns` list are stable.
 */
export const INPUT_DIMENSIONS: ReadonlyArray<DimensionDef> = [
  {
    dimension: "problem",
    label: "Problem / context (why)",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:problem|context|background|motivation)\b/i.test(
        d
      ) ||
      /\b(?:because|currently|today|the problem|problem is|motivation|pain point|users? (?:can'?t|cannot|are unable|struggle))\b/i.test(
        d
      ),
  },
  {
    dimension: "goal",
    label: "Goal / desired outcome",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:goal|objective|outcome)\b/i.test(d) ||
      /\b(?:goals?|objectives?|outcomes?|wants?(?:\sto)?|need(?:s|ed)?\sto|so that|in order to|should be able to|enable\b|deliver\b)\b/i.test(
        d
      ),
  },
  {
    dimension: "constraints",
    label: "Constraints / requirements",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:constraints?|requirements?)\b/i.test(d) ||
      /\b(?:constraints?|must(?:\snot)?\b|requires?\b|required\b|only\b|cannot\b|can'?t\b|should not|limit(?:ed|ation)?\b|within\b|no more than|at most|reuse the existing)\b/i.test(
        d
      ),
  },
  {
    dimension: "successCriteria",
    label: "Success criteria / acceptance",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:success|acceptance|done\swhen)\b/i.test(d) ||
      /\b(?:success (?:criteria|metric)|acceptance (?:criteria|test)|done when|definition of done|measur(?:e|able)|works? when|verif(?:y|iable|ied))\b/i.test(
        d
      ),
  },
  {
    dimension: "scope",
    label: "Scope / non-goals",
    detect: (d) =>
      /(?:^|\n)#{1,6}\s+[^\n]*\b(?:non-?goals?|scope)\b/i.test(d) ||
      /\b(?:non-?goals?|out of scope|not in scope|not (?:include|building|doing)|exclude[ds]?|won'?t (?:do|build|change|ship)|do not (?:include|build))\b/i.test(
        d
      ),
  },
];

export type InputDimensionResult = {
  dimension: InputDimension;
  label: string;
  met: boolean;
};

export type InputSharpnessScore = {
  /** Per-dimension outcome, in fixed scorecard order. */
  results: InputDimensionResult[];
  /** Dimensions present. */
  metCount: number;
  /** Total dimensions (the denominator). */
  maxScore: number;
  /** metCount / maxScore in 0..1; 0 when there are no dimensions. */
  ratio: number;
  /** Labels of absent dimensions — the unknowns a sharpening pass must clarify
   *  with the operator, or record an explicit assumption for in AFK. */
  unknowns: string[];
};

/**
 * Score a raw input against the sharpness dimensions. Pure; deterministic
 * heuristics only. The `unknowns` are exactly the unmet dimensions — the
 * "what to clarify before planning" surface a later P23 slice acts on.
 */
export function scoreInputSharpness(input: string): InputSharpnessScore {
  const results: InputDimensionResult[] = INPUT_DIMENSIONS.map((d) => ({
    dimension: d.dimension,
    label: d.label,
    met: d.detect(input),
  }));
  const metCount = results.reduce((n, r) => n + (r.met ? 1 : 0), 0);
  const maxScore = results.length;
  return {
    results,
    metCount,
    maxScore,
    ratio: maxScore > 0 ? metCount / maxScore : 0,
    unknowns: results.filter((r) => !r.met).map((r) => r.label),
  };
}

/**
 * Build the bounded, injectable sharpening-guidance block for the plan stage
 * (P23 slice 2). When the input is already sharp (no unknowns) this is the empty
 * string, so a run injects nothing and the plan prompt is byte-identical — the
 * "inert when not needed" rule every Otto system follows. When gaps exist it
 * names them and directs the plan author to sharpen autonomously and record an
 * explicit assumption per gap (no human is present in AFK) in the spec's
 * `## Decisions` section, which the plan-quality rubric already scores. Pure.
 */
export function formatSharpeningGuidance(score: InputSharpnessScore): string {
  if (score.unknowns.length === 0) return "";
  const n = score.unknowns.length;
  return [
    `## Input sharpening (${n} gap${n === 1 ? "" : "s"} detected)`,
    "",
    `Otto scored this run's input and it does not clearly state: ` +
      `**${score.unknowns.join("**, **")}**. No human is available — sharpen the ` +
      `input autonomously before authoring the spec:`,
    "",
    "- Extract each missing dimension from `<inputs>` and the existing repo; do " +
      "not invent scope or gold-plate (YAGNI).",
    "- Where the implementation path is genuinely ambiguous, weigh 2-3 options " +
      "and pick the simplest viable one.",
    "- Record an explicit assumption for each gap above in the spec's " +
      "`## Decisions` section (question → assumption → rationale) so a reviewer " +
      "can accept or correct it, and the plan gate can score it.",
  ].join("\n");
}

/**
 * Render an input-sharpness score as a short scorecard: a met/max header and a
 * per-dimension checklist, then either "no gaps" or the unknowns a sharpening
 * pass should clarify. Pure.
 */
export function formatInputSharpness(score: InputSharpnessScore): string {
  const header = `input sharpness: ${score.metCount}/${score.maxScore}`;
  const lines = score.results.map((r) => `  [${r.met ? "x" : " "}] ${r.label}`);
  const footer =
    score.unknowns.length === 0
      ? "  no gaps — input states every dimension"
      : `  clarify (or record an assumption for): ${score.unknowns.join(", ")}`;
  return [header, ...lines, footer].join("\n");
}
