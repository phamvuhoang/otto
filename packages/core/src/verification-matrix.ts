/**
 * Verification matrix (issue #181 P24, slice 1 — "make verification provable").
 *
 * A pure data model + scorer for the roadmap's verification-artifact matrix:
 * each requirement (a plan task / acceptance criterion) paired with HOW it was
 * checked, the concrete artifact that proves it (a `file:line`, a commit SHA, a
 * command transcript, a screenshot path), the result, and a confidence. Today
 * the `verify` stage emits this as free-form DONE/GAP/DEFERRED prose; P24 turns
 * it into a structured matrix a maintainer can scan, and a "verification
 * gallery" a non-engineer can accept/reject from.
 *
 * This slice is the substrate — the type, a summary scorer (counts, artifact
 * coverage, an overall verdict), and a formatter that renders the matrix and
 * surfaces failures / unproven requirements as explicit risks rather than
 * burying them in logs. INERT on the loop: nothing here runs a stage or changes
 * behavior; later P24 slices populate it from the verify stage and fold it into
 * run reports + `otto-inspect`. Mirrors how the plan/context/report rubrics
 * shipped pure-then-wired.
 */

/** How a requirement was checked. */
export type VerificationMethod =
  | "test" // an automated test / suite
  | "command" // a CLI command + its observed output
  | "visual" // a screenshot / rendered-UI check
  | "inspection" // code/commit inspection (file:line, SHA)
  | "manual"; // a human/operator check

/** The outcome of checking a requirement. */
export type VerificationResult = "pass" | "fail" | "partial" | "deferred";

/** How much the evidence supports the result. */
export type VerificationConfidence = "high" | "medium" | "low";

/** One row of the verification matrix: a requirement and how it was proven. */
export type VerificationEntry = {
  /** The requirement / plan task / acceptance criterion being verified. */
  requirement: string;
  method: VerificationMethod;
  /** The concrete check: the command run, the assertion, or the visual checked. */
  check: string;
  /** Pointer to the proving artifact: `file:line`, a commit SHA, a transcript or
   *  screenshot path. Absent ⇒ the requirement is asserted but not artifact-backed. */
  artifactPath?: string;
  result: VerificationResult;
  confidence: VerificationConfidence;
  note?: string;
};

const METHODS: ReadonlySet<string> = new Set([
  "test",
  "command",
  "visual",
  "inspection",
  "manual",
]);
const RESULTS: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "partial",
  "deferred",
]);
const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

/**
 * Parse an agent-emitted verification matrix (a JSON `VerificationEntry[]`,
 * e.g. the `.otto-tmp/verify-matrix.json` the verify stage writes) into validated
 * entries. Tolerant like `parsePlanTasks`: never throws, drops any entry missing
 * a non-empty `requirement` or carrying an unknown `method`/`result`, and
 * defaults an absent/invalid `confidence` to `medium`. Non-array / malformed
 * JSON ⇒ `[]`. Pure.
 */
export function parseVerificationMatrix(raw: string): VerificationEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: VerificationEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const requirement =
      typeof r.requirement === "string" ? r.requirement.trim() : "";
    if (!requirement) continue;
    if (typeof r.method !== "string" || !METHODS.has(r.method)) continue;
    if (typeof r.result !== "string" || !RESULTS.has(r.result)) continue;
    const confidence =
      typeof r.confidence === "string" && CONFIDENCES.has(r.confidence)
        ? (r.confidence as VerificationConfidence)
        : "medium";
    entries.push({
      requirement,
      method: r.method as VerificationMethod,
      check: typeof r.check === "string" ? r.check : "",
      ...(typeof r.artifactPath === "string" && r.artifactPath
        ? { artifactPath: r.artifactPath }
        : {}),
      result: r.result as VerificationResult,
      confidence,
      ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
    });
  }
  return entries;
}

/** Whether a requirement is one we expect a concrete artifact for (i.e. not deferred). */
function isVerifiable(e: VerificationEntry): boolean {
  return e.result !== "deferred";
}

export type VerificationSummary = {
  total: number;
  pass: number;
  fail: number;
  partial: number;
  deferred: number;
  /** Entries carrying a concrete artifact path. */
  withArtifact: number;
  /** Artifact-backed share of the *verifiable* (non-deferred) requirements, 0..1. */
  coverage: number;
  /**
   * Overall verdict:
   * - `empty` — nothing to verify.
   * - `gaps` — at least one requirement failed.
   * - `unproven` — no failures, but no verifiable requirement is artifact-backed.
   * - `partial` — no failures, some but not all verifiable requirements proven.
   * - `verified` — no failures and every verifiable requirement is artifact-backed.
   */
  verdict: "empty" | "gaps" | "unproven" | "partial" | "verified";
};

/** Tally a verification matrix into counts, artifact coverage, and a verdict. Pure. */
export function summarizeVerification(
  entries: VerificationEntry[]
): VerificationSummary {
  const total = entries.length;
  const pass = entries.filter((e) => e.result === "pass").length;
  const fail = entries.filter((e) => e.result === "fail").length;
  const partial = entries.filter((e) => e.result === "partial").length;
  const deferred = entries.filter((e) => e.result === "deferred").length;
  const verifiable = entries.filter(isVerifiable);
  const withArtifact = entries.filter((e) => Boolean(e.artifactPath)).length;
  const verifiableProven = verifiable.filter((e) =>
    Boolean(e.artifactPath)
  ).length;
  const coverage =
    verifiable.length > 0 ? verifiableProven / verifiable.length : 0;

  let verdict: VerificationSummary["verdict"];
  if (total === 0) verdict = "empty";
  else if (fail > 0) verdict = "gaps";
  else if (verifiable.length > 0 && verifiableProven === 0)
    verdict = "unproven";
  else if (coverage >= 1 && partial === 0) verdict = "verified";
  else verdict = "partial";

  return {
    total,
    pass,
    fail,
    partial,
    deferred,
    withArtifact,
    coverage,
    verdict,
  };
}

const RESULT_MARK: Record<VerificationResult, string> = {
  pass: "✓",
  fail: "✗",
  partial: "~",
  deferred: "·",
};

const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Render a verification matrix as a scannable report: a header verdict line, one
 * row per requirement (mark · method · requirement · artifact), and an explicit
 * **Risks** section listing every failed or unproven requirement so a reader
 * cannot miss them. Pure.
 */
export function formatVerificationMatrix(entries: VerificationEntry[]): string {
  if (entries.length === 0) {
    return "Verification: no verification recorded for this run.";
  }
  const s = summarizeVerification(entries);
  const lines: string[] = [
    `Verification: ${s.verdict} — ${s.pass}/${s.total} pass` +
      (s.fail > 0 ? `, ${s.fail} fail` : "") +
      (s.partial > 0 ? `, ${s.partial} partial` : "") +
      (s.deferred > 0 ? `, ${s.deferred} deferred` : "") +
      ` · ${pct.format(s.coverage * 100)}% artifact-backed`,
  ];
  for (const e of entries) {
    const artifact = e.artifactPath
      ? ` → ${e.artifactPath}`
      : " → (no artifact)";
    const conf = e.confidence !== "high" ? ` [${e.confidence}]` : "";
    lines.push(
      `  ${RESULT_MARK[e.result]} ${e.method}: ${e.requirement}${conf}${artifact}`
    );
  }
  const risks = entries.filter(
    (e) => e.result === "fail" || (isVerifiable(e) && !e.artifactPath)
  );
  if (risks.length > 0) {
    lines.push("", `Risks (${risks.length}):`);
    for (const e of risks) {
      const why = e.result === "fail" ? "failed" : "unproven (no artifact)";
      lines.push(`  - ${e.requirement} — ${why}`);
    }
  }
  return lines.join("\n");
}
