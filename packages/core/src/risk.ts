/**
 * The adaptive compute router's risk-classification substrate (issue #41). Pure:
 * a run's review depth is routed by the *class* and *level* of its change,
 * derived deterministically from the set of changed file paths — no I/O, no
 * model calls — so the routing is reproducible and the eval suite (#40) can A/B
 * `adaptive-router on/off`. Kept inert (no bin/loop imports it) until a later
 * task wires it behind an off-by-default flag.
 */

/** The category of a change, in increasing review attention. */
export type RiskClass =
  | "docs-only"
  | "test-only"
  | "narrow-code"
  | "cross-module"
  | "security-sensitive"
  | "migration-release"
  | "unknown";

/** Coarse risk level the review depth is routed by. */
export type RiskLevel = "low" | "medium" | "high";

/** How much review a change gets: one reviewer, selected lenses, or full panel. */
export type ReviewDepth = "single" | "lenses" | "panel";

/** The classification of a change plus why it was reached. */
export type RiskAssessment = {
  class: RiskClass;
  level: RiskLevel;
  /** Human-readable signals that drove the classification. */
  reasons: string[];
};

const LEVEL_OF: Record<RiskClass, RiskLevel> = {
  "docs-only": "low",
  "test-only": "low",
  "narrow-code": "medium",
  "cross-module": "high",
  "security-sensitive": "high",
  "migration-release": "high",
  unknown: "high",
};

const SECURITY_RE = /auth|credential|secret|token|crypto|sandbox|permission|security/i;
const MIGRATION_RE = /(^|\/)migrations?\//i;
const RELEASE_RE = /(^|\/)(package\.json|CHANGELOG(\.md)?|release-please[^/]*)$/i;

function isDoc(path: string): boolean {
  return /\.md$/i.test(path) || /(^|\/)docs?\//i.test(path);
}

function isTest(path: string): boolean {
  return (
    /\.(test|spec)\.[^/]+$/i.test(path) ||
    /(^|\/)(__tests__|tests?)\//i.test(path)
  );
}

function isLockfile(path: string): boolean {
  return /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i.test(
    path
  );
}

/** Top-level path segment, used to detect a change spanning multiple modules. */
function topSegment(path: string): string {
  const norm = path.replace(/^\.\//, "");
  const i = norm.indexOf("/");
  return i === -1 ? norm : norm.slice(0, i);
}

/**
 * Classify a change into a {@link RiskAssessment} from its changed file paths.
 * Precedence (highest-risk class wins, so a sensitive path can't be masked by a
 * co-changed benign one): security-sensitive → migration-release → docs-only /
 * test-only / cross-module / narrow-code → unknown (empty set). Pure.
 */
export function classifyRisk(changedPaths: string[]): RiskAssessment {
  const paths = changedPaths.filter((p) => p.length > 0);
  if (paths.length === 0) {
    return { class: "unknown", level: LEVEL_OF.unknown, reasons: ["no changed paths visible"] };
  }

  const security = paths.filter((p) => SECURITY_RE.test(p));
  if (security.length > 0) {
    return assess("security-sensitive", [`security-sensitive path(s): ${security.join(", ")}`]);
  }

  const migration = paths.filter(
    (p) => MIGRATION_RE.test(p) || RELEASE_RE.test(p) || isLockfile(p) || /\.sql$/i.test(p)
  );
  if (migration.length > 0) {
    return assess("migration-release", [`migration/release artifact(s): ${migration.join(", ")}`]);
  }

  if (paths.every(isDoc)) {
    return assess("docs-only", ["all changed paths are documentation"]);
  }
  if (paths.every(isTest)) {
    return assess("test-only", ["all changed paths are tests"]);
  }

  const codePaths = paths.filter((p) => !isDoc(p) && !isTest(p));
  const segments = new Set(codePaths.map(topSegment));
  if (segments.size >= 2) {
    return assess("cross-module", [
      `code spans ${segments.size} top-level segments: ${[...segments].join(", ")}`,
    ]);
  }
  return assess("narrow-code", [`code change within ${[...segments][0] ?? "one module"}`]);
}

function assess(cls: RiskClass, reasons: string[]): RiskAssessment {
  return { class: cls, level: LEVEL_OF[cls], reasons };
}

/** Route review depth by risk level: low → single, medium → lenses, high → panel. */
export function reviewDepthForLevel(level: RiskLevel): ReviewDepth {
  switch (level) {
    case "low":
      return "single";
    case "medium":
      return "lenses";
    case "high":
      return "panel";
  }
}

/**
 * Choose which review lenses run at a {@link ReviewDepth}, drawn (in order) from
 * the available pool: `single` → none (a plain single reviewer), `lenses` → the
 * medium subset (correctness, tests, task-fit — excludes security and structural),
 * `panel` → the full pool including structural. Pure.
 */
export function selectLenses(depth: ReviewDepth, available: string[]): string[] {
  switch (depth) {
    case "single":
      return [];
    case "lenses": {
      const medium = ["correctness", "tests", "task-fit"];
      return available.filter((l) => medium.includes(l));
    }
    case "panel":
      return [...available];
  }
}

/** A per-iteration review-routing decision: how deep, which lenses, and why. */
export type RouteDecision = {
  depth: ReviewDepth;
  lenses: string[];
  assessment: RiskAssessment;
};

/**
 * Route one iteration's review from its changed paths and the available lens
 * pool: classify the change, map the risk level to a depth, and select the
 * lenses for that depth. Pure — the loop calls this behind the adaptive-router
 * flag and runs the returned lens set (empty = single reviewer).
 */
export function routeReview(
  changedPaths: string[],
  available: string[]
): RouteDecision {
  const assessment = classifyRisk(changedPaths);
  const depth = reviewDepthForLevel(assessment.level);
  return { depth, lenses: selectLenses(depth, available), assessment };
}

/**
 * Render a {@link RouteDecision} as a multi-line operator explanation: the change
 * class + risk level, the signals that drove it, and the chosen review depth +
 * lenses. Pure — the loop prints this each iteration under `--explain-routing`
 * (issue #45) so a maintainer can see *why* a given review depth was selected.
 */
export function explainRouting(route: RouteDecision): string {
  const { assessment, depth, lenses } = route;
  const lensLabel = lenses.length
    ? lenses.join(", ")
    : "(none — single reviewer)";
  return [
    `routing: ${assessment.class} (risk ${assessment.level})`,
    ...assessment.reasons.map((r) => `  · ${r}`),
    `  → review depth: ${depth}; lenses: ${lensLabel}`,
  ].join("\n");
}
