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
   *  screenshot path. Absent ⇒ the requirement is asserted but not artifact-backed.
   *  For a `visual` before/after entry this is the **after** screenshot. */
  artifactPath?: string;
  /** For a `visual` entry, the optional **before** screenshot path, paired with
   *  `artifactPath` (the after) for a before/after comparison. */
  beforePath?: string;
  /** Set by the loop's filesystem/git validation (issue #181 re-review): whether
   *  `artifactPath` actually resolves to an existing file (with in-bounds line)
   *  or a commit present in git. `false` ⇒ the cited proof does not exist and the
   *  requirement is not counted as covered. Never read from agent JSON. */
  artifactExists?: boolean;
  /** Set true ONLY by the impure layer when `artifactPath` was actually copied
   *  into the physical run bundle (issue #181 boundary review). Embedding trusts
   *  this flag, not a string prefix the agent could spoof. Never read from agent JSON. */
  artifactBundled?: boolean;
  /** Set true ONLY by the impure layer when `beforePath` was copied into the
   *  physical run bundle. Never read from agent JSON. */
  beforeBundled?: boolean;
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
 * Whether a string is a *typed*, durable artifact reference that actually proves
 * something — a `file:line` (or `file:line-range`), a path with a separator or a
 * file extension (a transcript / screenshot / source file), or a 7–40 char commit
 * SHA. A bare command (`node --test`), prose (`read the code`), or a placeholder
 * (`TODO`) is NOT proof and returns false, so the coverage signal can't be earned
 * by an unverifiable string (#181 review). Pure.
 */
export function isValidArtifactReference(ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (/\s/.test(r)) return false; // commands / prose carry whitespace
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) return false; // URLs (scheme://)
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(r)) return false; // path traversal
  if (/^[0-9a-f]{7,40}$/i.test(r)) return true; // commit SHA
  if (/^[\w./\\-]+:\d+(?:-\d+)?$/.test(r)) return true; // file:line or file:line-range
  return /[/\\]/.test(r) || /\.[A-Za-z0-9]{1,8}$/.test(r); // a path, or a file with an extension
}

/**
 * Whether an entry carries a *valid, typed* proving artifact. Syntactically valid
 * (see {@link isValidArtifactReference}) AND not marked non-existent by the loop's
 * filesystem/git validation (`artifactExists === false`). When `artifactExists` is
 * undefined the syntax check stands alone — the pure scorer cannot touch the
 * filesystem, so the loop sets `artifactExists` before this matters at runtime.
 */
function hasArtifact(e: VerificationEntry): boolean {
  return (
    Boolean(e.artifactPath) &&
    isValidArtifactReference(e.artifactPath!) &&
    e.artifactExists !== false
  );
}

export type VerificationParseResult = {
  /** Valid entries kept. */
  entries: VerificationEntry[];
  /** Rows present in the JSON array that were rejected as malformed. */
  dropped: number;
  /** False when the input was not parseable JSON or not an array. */
  parsed: boolean;
};

/**
 * Parse an agent-emitted verification matrix (a JSON `VerificationEntry[]`,
 * e.g. the `.otto-tmp/verify-matrix.json` the verify stage writes), keeping the
 * parse diagnostics so a malformed/partial matrix is reported, not silently
 * dropped (#181 review). Tolerant: never throws, drops any entry missing a
 * non-empty `requirement` or carrying an unknown `method`/`result`, defaults an
 * absent/invalid `confidence` to `medium`, and counts each dropped row. Non-array
 * / malformed JSON ⇒ `{ entries: [], dropped: 0, parsed: false }`. Pure.
 */
export function parseVerificationMatrixWithDiagnostics(
  raw: string
): VerificationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], dropped: 0, parsed: false };
  }
  if (!Array.isArray(parsed)) return { entries: [], dropped: 0, parsed: false };
  const entries: VerificationEntry[] = [];
  let dropped = 0;
  for (const item of parsed) {
    const entry = coerceEntry(item);
    if (entry) entries.push(entry);
    else dropped += 1;
  }
  return { entries, dropped, parsed: true };
}

function coerceEntry(item: unknown): VerificationEntry | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const requirement =
    typeof r.requirement === "string" ? r.requirement.trim() : "";
  if (!requirement) return null;
  if (typeof r.method !== "string" || !METHODS.has(r.method)) return null;
  if (typeof r.result !== "string" || !RESULTS.has(r.result)) return null;
  const confidence =
    typeof r.confidence === "string" && CONFIDENCES.has(r.confidence)
      ? (r.confidence as VerificationConfidence)
      : "medium";
  return {
    requirement,
    method: r.method as VerificationMethod,
    check: typeof r.check === "string" ? r.check : "",
    ...(typeof r.artifactPath === "string" && r.artifactPath
      ? { artifactPath: r.artifactPath }
      : {}),
    ...(typeof r.beforePath === "string" && r.beforePath
      ? { beforePath: r.beforePath }
      : {}),
    result: r.result as VerificationResult,
    confidence,
    ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
  };
}

/** Parse a verification matrix into valid entries (diagnostics discarded). Pure. */
export function parseVerificationMatrix(raw: string): VerificationEntry[] {
  return parseVerificationMatrixWithDiagnostics(raw).entries;
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
  const withArtifact = entries.filter(hasArtifact).length;
  const verifiableProven = verifiable.filter(hasArtifact).length;
  // Vacuous truth: an all-deferred matrix (entries, but none verifiable) is fully
  // covered — there is nothing left to prove (#181 review). An empty matrix has
  // nothing measured, so coverage is 0.
  const coverage =
    total === 0
      ? 0
      : verifiable.length > 0
        ? verifiableProven / verifiable.length
        : 1;

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

/**
 * How a verification matrix reconciles against the plan's task set (issue #201).
 * The matrix is authored by the agent, so an unfinished task can simply be
 * omitted; comparing row count against the plan's task count closes that hole.
 */
export type PlanReconciliation = {
  planTasks: number;
  matrixRows: number;
  /** True when the matrix has fewer rows than the plan has tasks — at least one
   *  plan task was never verified. */
  shortfall: boolean;
  /** Plan task titles with no fuzzy-matching matrix row — best-effort naming of
   *  the omissions (token overlap, not semantic proof). */
  unmatched: string[];
};

/** Distinct lowercase alphanumeric tokens of 4+ chars — the words that carry a
 *  title's identity once articles/prepositions fall away. */
function significantTokens(s: string): string[] {
  return [...new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (w) => w.length >= 4
  );
}

/**
 * Reconcile a verification matrix against the plan's task titles: a coarse
 * row-count check (fewer rows than tasks ⇒ something was omitted) plus a
 * best-effort naming of which titles no row appears to cover (a title is covered
 * when some row's requirement+check shares at least half its significant
 * tokens). Naming is a hint for the reader; only the count drives the gate,
 * since token overlap cannot prove semantic coverage. Pure.
 */
export function reconcileMatrixWithPlan(
  entries: VerificationEntry[],
  planTaskTitles: string[]
): PlanReconciliation {
  const rows = entries.map(
    (e) => new Set(significantTokens(`${e.requirement} ${e.check ?? ""}`))
  );
  const unmatched = planTaskTitles.filter((title) => {
    const tokens = significantTokens(title);
    if (tokens.length === 0) {
      const t = title.trim().toLowerCase();
      return !entries.some((e) => e.requirement.toLowerCase().includes(t));
    }
    const needed = Math.ceil(tokens.length / 2);
    return !rows.some(
      (row) => tokens.filter((tk) => row.has(tk)).length >= needed
    );
  });
  return {
    planTasks: planTaskTitles.length,
    matrixRows: entries.length,
    shortfall: entries.length < planTaskTitles.length,
    unmatched,
  };
}

export type VerificationCoverageGate = {
  /** True iff no requirement failed, every verifiable one is artifact-backed,
   *  no matrix rows were dropped during parsing, and — when a plan is attached —
   *  the matrix has at least as many rows as the plan has tasks. */
  passed: boolean;
  /** Artifact-backed share of the verifiable requirements, 0..1. */
  coverage: number;
  /** Verifiable requirements asserted without a valid proving artifact. */
  unproven: string[];
  /** Requirements that failed verification. */
  failed: string[];
  /** Requirements left `partial` — checked but not fully passing. */
  incomplete: string[];
  /** Malformed matrix rows dropped during parsing — unknown, unverified requirements. */
  dropped: number;
  /** Plan reconciliation when a matching plan was attached (issue #201). */
  plan?: PlanReconciliation;
};

/**
 * Score a verification matrix against the roadmap's coverage bar (P24): every
 * verifiable requirement must carry a valid artifact, none may fail, none may be
 * left partial, and no rows may have been dropped during parsing. `dropped` rows
 * are unknown requirements that cannot be assumed proven, so any drop FAILs the
 * gate (#181 re-review). The `unproven`/`failed`/`incomplete` lists + `dropped`
 * are exactly why the gate did not pass. Pure.
 */
export function scoreVerificationCoverage(
  entries: VerificationEntry[],
  dropped = 0,
  plan?: PlanReconciliation
): VerificationCoverageGate {
  const summary = summarizeVerification(entries);
  return {
    passed: summary.verdict === "verified" && dropped === 0 && !plan?.shortfall,
    coverage: summary.coverage,
    unproven: entries
      .filter((e) => isVerifiable(e) && !hasArtifact(e))
      .map((e) => e.requirement),
    failed: entries
      .filter((e) => e.result === "fail")
      .map((e) => e.requirement),
    incomplete: entries
      .filter((e) => e.result === "partial")
      .map((e) => e.requirement),
    dropped,
    ...(plan ? { plan } : {}),
  };
}

/**
 * Render the verification-coverage gate as a report block (mirrors the emit-time
 * legibility gate): a PASS/FAIL verdict, the artifact-backed coverage, and — on
 * FAIL — the unproven/failed requirements plus how to clear them. Empty string
 * for an empty matrix, so a run with no verification adds no gate. Pure.
 */
export function formatVerificationCoverageGate(
  entries: VerificationEntry[],
  dropped = 0,
  plan?: PlanReconciliation
): string {
  if (entries.length === 0 && dropped === 0) return "";
  const g = scoreVerificationCoverage(entries, dropped, plan);
  const lines = [
    "## Verification Coverage Gate",
    "",
    `Gate: **${g.passed ? "PASS" : "FAIL"}** — ${pct.format(g.coverage * 100)}% of verifiable requirements are artifact-backed.`,
  ];
  if (!g.passed) {
    if (g.plan?.shortfall) {
      const named =
        g.plan.unmatched.length > 0
          ? ` — not obviously covered: ${g.plan.unmatched.join(", ")}`
          : "";
      lines.push(
        "",
        `Plan reconciliation: the plan has ${g.plan.planTasks} task(s) but the matrix has only ${g.plan.matrixRows} row(s); omitted plan task(s) are unverified gaps${named}.`
      );
    }
    if (g.dropped > 0) {
      lines.push(
        "",
        `Dropped ${g.dropped} malformed matrix row(s) — those requirements are unknown and unverified; fix the matrix.`
      );
    }
    if (g.failed.length > 0) {
      lines.push("", `Failed: ${g.failed.join(", ")}.`);
    }
    if (g.incomplete.length > 0) {
      lines.push(
        "",
        `Incomplete (partial — finish or split): ${g.incomplete.join(", ")}.`
      );
    }
    if (g.unproven.length > 0) {
      lines.push(
        "",
        `Unproven (cite a valid artifact — \`file:line\`, a commit SHA, a transcript/screenshot path — or mark the requirement \`deferred\`): ${g.unproven.join(", ")}.`
      );
    }
    // A FAIL with no failed/incomplete/unproven items would be unexplained; make
    // the residual reason explicit rather than leaving an empty gate (#181 review).
    if (
      g.dropped === 0 &&
      g.failed.length === 0 &&
      g.incomplete.length === 0 &&
      g.unproven.length === 0 &&
      !g.plan?.shortfall
    ) {
      lines.push(
        "",
        "No requirement is fully proven, yet none is individually failed/partial/unproven — review the matrix."
      );
    }
  }
  return lines.join("\n");
}

/** Path prefix of artifacts relocated into the run bundle (see
 *  `verification-evidence.ts`); only these resolve relative to report.md. */
export const BUNDLE_ARTIFACT_PREFIX = "verification/";
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;

/**
 * A path safe to embed as a markdown image: it was actually copied into the
 * physical run bundle by the impure layer (`bundled === true` — not a string
 * prefix the agent could spoof) and has an image extension. So a rejected URL, an
 * un-relocated path, or an agent-supplied `verification/…` masquerade is never
 * emitted as an image (#181 boundary review).
 */
function embeddableImage(
  p: string | undefined,
  bundled: boolean | undefined
): p is string {
  return (
    bundled === true &&
    typeof p === "string" &&
    !p.includes("..") &&
    IMAGE_RE.test(p)
  );
}

/**
 * Render the visual evidence (P24 visual half) as a markdown "Screenshot
 * Evidence" section that *embeds* each `visual` entry's captured screenshot —
 * a single image, or a before → after pair — so a non-engineer reading the run
 * report sees the proof, not just a path. Only artifacts the impure layer actually
 * **copied into the bundle** (`artifactBundled`/`beforeBundled`) and that are
 * images are embedded; a visual check the environment could not render, or any
 * unbundled/spoofed path, is left to the coverage gate to flag, never emitted as
 * an image. Empty string when no embeddable visual evidence exists. Pure.
 */
export function formatVisualEvidence(entries: VerificationEntry[]): string {
  const visuals = entries.filter(
    (e) =>
      e.method === "visual" &&
      embeddableImage(e.artifactPath, e.artifactBundled)
  );
  if (visuals.length === 0) return "";
  const lines: string[] = ["## Screenshot Evidence", ""];
  for (const e of visuals) {
    lines.push(`### ${e.requirement}`, "");
    if (embeddableImage(e.beforePath, e.beforeBundled)) {
      lines.push(`- Before: ![before](${e.beforePath})`);
      lines.push(`- After: ![after](${e.artifactPath})`);
    } else {
      lines.push(`![${e.requirement}](${e.artifactPath})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

const RESULT_MARK: Record<VerificationResult, string> = {
  pass: "✓",
  fail: "✗",
  partial: "~",
  deferred: "·",
};

const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Collapse a (possibly multi-line) check to one bounded, fence-safe line. */
function oneLine(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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
    const artifact = hasArtifact(e)
      ? ` → ${e.artifactPath}`
      : e.artifactPath
        ? ` → ${e.artifactPath} (not a valid artifact)`
        : " → (no artifact)";
    const conf = e.confidence !== "high" ? ` [${e.confidence}]` : "";
    const check = e.check ? `  · check: ${oneLine(e.check)}` : "";
    lines.push(
      `  ${RESULT_MARK[e.result]} ${e.method}: ${e.requirement}${conf}${artifact}${check}`
    );
  }
  const risks = entries.filter(
    (e) => e.result === "fail" || (isVerifiable(e) && !hasArtifact(e))
  );
  if (risks.length > 0) {
    lines.push("", `Risks (${risks.length}):`);
    for (const e of risks) {
      const why =
        e.result === "fail" ? "failed" : "unproven (no valid artifact)";
      lines.push(`  - ${e.requirement} — ${why}`);
    }
  }
  return lines.join("\n");
}
