/**
 * Canonical review renderer and local outputs (P32 Task 8).
 *
 * Exactly ONE structured type — {@link CanonicalReview} — feeds exactly ONE
 * canonical Markdown renderer ({@link renderCanonicalReview}); the terminal
 * text form ({@link renderReviewText}) is DERIVED from that same structure, not
 * a second data path. This module performs NO GitHub I/O and NO diff-line
 * mapping (both land in Task 14's formal publisher) — only rendering, the
 * stable idempotency markers those later tasks key off of, and local file
 * writes.
 *
 * Two trust rules the renderer enforces on every call:
 *  - A REJECTED candidate claim is never rendered as a defect — only its
 *    aggregate count appears, so a claim the verifier did not confirm can
 *    never masquerade as a finding.
 *  - Review-input PROVENANCE (kind/source/fingerprint/artifact) is rendered;
 *    the untrusted content itself (e.g. a `direct` prompt's raw text) never
 *    is. `reviewInput` on {@link CanonicalReview} is deliberately narrowed to
 *    exclude `content` so there is no field to accidentally echo.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { PullRequestReviewOutcome } from "./pr-review.js";
import type { ReviewInputSnapshot } from "./pr-review-input.js";
import type { ReviewSkillSelection } from "./pr-review-skill.js";
import {
  rankFindings,
  type Finding,
  type Severity,
} from "./review-severity.js";
import { checkWritePath, readSafetyPolicy } from "./safety-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A confirmed finding plus its (optional) placement for an inline PR comment. */
export type PublishedReviewFinding = Finding & {
  side?: "LEFT" | "RIGHT";
  mappedLine?: number;
  inlineEligible: boolean;
};

/**
 * The single structured source of every review rendering. Every field a
 * renderer needs lives here — nothing is fetched or recomputed downstream.
 * `reviewInput` is narrowed to PROVENANCE only (never `content`), so an
 * untrusted direct-prompt/issue/file body has no field to leak through.
 */
export type CanonicalReview = {
  repository: string;
  pullRequest: number;
  url: string;
  title: string;
  baseSha: string;
  headSha: string;
  reviewInput: Pick<
    ReviewInputSnapshot,
    "kind" | "source" | "fingerprint" | "artifactPath"
  >;
  runId: string;
  outcome: PullRequestReviewOutcome;
  confirmed: PublishedReviewFinding[];
  rejectedCount: number;
  suppressedCount: number;
  skill: ReviewSkillSelection;
  diffArtifact: string;
  analysisArtifact: string;
  staleReason?: string;
};

// ---------------------------------------------------------------------------
// Marker validation
// ---------------------------------------------------------------------------

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-fA-F]{40,64}$/;
const REPO_RE = /^[^\s#]+\/[^\s#]+$/;

function assertRepository(repository: string): void {
  if (!REPO_RE.test(repository)) {
    throw new Error(
      `repository must be "owner/name" with no "#" or whitespace, got: ${JSON.stringify(repository)}`
    );
  }
}

function assertPr(pr: number): void {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(
      `pull request number must be a positive integer, got: ${JSON.stringify(pr)}`
    );
  }
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new Error(
      `head SHA must be 40-64 hex characters, got: ${JSON.stringify(sha)}`
    );
  }
}

function assertFingerprint(fingerprint: string): void {
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new Error(
      `input fingerprint must be 64 lower-case hex characters, got: ${JSON.stringify(fingerprint)}`
    );
  }
}

/** `<!-- otto-review:owner/repo#123 -->` — the stable per-PR summary marker. */
export function summaryMarker(repository: string, pr: number): string {
  assertRepository(repository);
  assertPr(pr);
  return `<!-- otto-review:${repository}#${pr} -->`;
}

/** `<!-- otto-review-head:<sha> -->` — the exact reviewed head revision. */
export function headMarker(headSha: string): string {
  assertSha(headSha);
  return `<!-- otto-review-head:${headSha} -->`;
}

/** `<!-- otto-review-input:<64-lower-hex> -->` — the exact review-input fingerprint. */
export function inputMarker(inputFingerprint: string): string {
  assertFingerprint(inputFingerprint);
  return `<!-- otto-review-input:${inputFingerprint} -->`;
}

/**
 * `<!-- otto-review:owner/repo#123@<head-sha>:<input-fingerprint> -->` — the
 * composite formal-review idempotency key. Rendered here as a pure function
 * only; the formal (GitHub) publisher is the one that actually emits it on a
 * live review comment (Task 14).
 */
export function reviewMarker(
  repository: string,
  pr: number,
  headSha: string,
  inputFingerprint: string
): string {
  assertRepository(repository);
  assertPr(pr);
  assertSha(headSha);
  assertFingerprint(inputFingerprint);
  return `<!-- otto-review:${repository}#${pr}@${headSha}:${inputFingerprint} -->`;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function outcomeLabel(outcome: PullRequestReviewOutcome): string {
  switch (outcome) {
    case "changes-requested":
      return "Changes requested";
    case "comment":
      return "Comment";
    case "approved":
      return "Approved";
  }
}

function tally(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
  };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** First 12 hex characters of a fingerprint — enough to disambiguate in a
 *  terminal without dumping the full 64-character digest. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Canonical Markdown
// ---------------------------------------------------------------------------

/**
 * Render the ONE canonical Markdown review document. Section order is fixed:
 * `# Otto PR code review` (with the summary/head/input markers immediately
 * after it), `## Verdict`, `## Confirmed findings`, `## Review integrity`,
 * `## Evidence`, `## Reproduce`. A stale review's document begins with a
 * prominent warning BEFORE the H1, so a truncated preview still shows it.
 */
export function renderCanonicalReview(review: CanonicalReview): string {
  const lines: string[] = [];

  if (review.staleReason !== undefined) {
    lines.push(
      `> **STALE — NOT PUBLISHED.** This review no longer reflects the current pull request revision and was not published: ${review.staleReason}`,
      ""
    );
  }

  lines.push(
    "# Otto PR code review",
    "",
    summaryMarker(review.repository, review.pullRequest),
    headMarker(review.headSha),
    inputMarker(review.reviewInput.fingerprint),
    "",
    `Repository: ${review.repository}`,
    `Pull request: #${review.pullRequest} — ${review.title} (${review.url})`,
    `Head SHA: ${review.headSha}`,
    `Review input: ${review.reviewInput.kind} (${review.reviewInput.source}), fingerprint ${review.reviewInput.fingerprint}`,
    ""
  );

  lines.push("## Verdict", "", `Outcome: ${outcomeLabel(review.outcome)}`, "");
  const counts = tally(review.confirmed);
  lines.push(
    "Confirmed findings by severity:",
    "",
    `- blocker: ${counts.blocker}`,
    `- major: ${counts.major}`,
    `- minor: ${counts.minor}`,
    `- nit: ${counts.nit}`,
    ""
  );

  lines.push("## Confirmed findings", "");
  // Use rankFindings so publication order is deterministic even if the caller
  // did not already sort — identity is preserved so this cast is safe.
  const ordered = rankFindings(review.confirmed) as PublishedReviewFinding[];
  if (ordered.length === 0) {
    lines.push("No adversarially confirmed defects.", "");
  } else {
    for (const f of ordered) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`### ${f.severity.toUpperCase()} — ${loc}`, "");
      lines.push(`- Claim: ${f.claim}`);
      lines.push(`- Why: ${f.why}`);
      lines.push(`- Suggested fix: ${f.suggestedFix ?? "(none provided)"}`);
      lines.push(`- Lens: ${f.lens ?? "(unspecified)"}`);
      lines.push("");
    }
  }

  lines.push("## Review integrity", "");
  lines.push(
    `Rejected candidate claims: ${review.rejectedCount} (not published as defects — the verifier did not confirm them)`,
    `Suppressed low-value findings: ${review.suppressedCount}`,
    `Review skill: ${review.skill.name} v${review.skill.version} (source: ${review.skill.source}, checksum: ${review.skill.checksum})`,
    ""
  );

  lines.push("## Evidence", "");
  lines.push(
    `Diff artifact: ${review.diffArtifact}`,
    `Review-input artifact: ${review.reviewInput.artifactPath}`,
    `Analysis artifact: ${review.analysisArtifact}`,
    "",
    "Review limitations: this is an automated static review of the diff between " +
      "base and head; it does not execute code, run tests, or have access beyond " +
      "the declared review input and changed files.",
    ""
  );

  lines.push(
    "## Reproduce",
    "",
    `Run ID: ${review.runId}`,
    `Base SHA: ${review.baseSha}`,
    `Head SHA: ${review.headSha}`,
    `Pull request: ${review.url}`
  );

  return lines.join("\n");
}

/**
 * Render the body of a formal (native) GitHub review from the SAME
 * {@link CanonicalReview} structure. The immutable composite formal marker
 * `<!-- otto-review:owner/repo#pr@head:input -->` leads the body (it is the
 * idempotency key the publisher reconciles on), and the three stable
 * summary/head/input markers are dropped so only the composite one identifies
 * the review. Every confirmed finding — mappable OR unmappable — remains in the
 * body text, so a finding that could not be attached to an exact diff line is
 * still surfaced; the publisher additionally attaches the mappable ones as
 * inline comments. A formal review is only published for a non-stale revision,
 * so no stale warning is ever part of this body.
 */
export function renderFormalReviewBody(review: CanonicalReview): string {
  const composite = reviewMarker(
    review.repository,
    review.pullRequest,
    review.headSha,
    review.reviewInput.fingerprint
  );
  const drop = new Set([
    summaryMarker(review.repository, review.pullRequest),
    headMarker(review.headSha),
    inputMarker(review.reviewInput.fingerprint),
  ]);
  const stripped = renderCanonicalReview(review)
    .split("\n")
    .filter((line) => !drop.has(line))
    .join("\n");
  return `${composite}\n${stripped}`;
}

/**
 * Render one inline PR-review comment body for a mapped finding, in the fixed
 * `**<severity>: <claim>**` / `<why>` / `Lens: <lens-or-unknown>` format.
 */
export function renderInlineComment(finding: PublishedReviewFinding): string {
  return [
    `**${finding.severity}: ${finding.claim}**`,
    "",
    finding.why,
    "",
    `Lens: ${finding.lens ?? "unknown"}`,
  ].join("\n");
}

/**
 * Derive a concise terminal (text) form from the SAME {@link CanonicalReview}
 * structure — never a separately maintained rendering. Shows outcome, the
 * confirmed/rejected/suppressed counts, the run ID, and review-input
 * provenance (source + a short fingerprint prefix) — never raw review-input
 * content.
 */
export function renderReviewText(review: CanonicalReview): string {
  const lines: string[] = [];

  if (review.staleReason !== undefined) {
    lines.push(`STALE — NOT PUBLISHED: ${review.staleReason}`);
  }

  lines.push(`${review.repository}#${review.pullRequest} @ ${review.headSha}`);
  lines.push(`Outcome: ${outcomeLabel(review.outcome)}`);
  const counts = tally(review.confirmed);
  lines.push(
    `Confirmed: blocker=${counts.blocker} major=${counts.major} minor=${counts.minor} nit=${counts.nit}`
  );
  lines.push(
    `Rejected: ${review.rejectedCount}  Suppressed: ${review.suppressedCount}`
  );
  lines.push(
    `Review input: ${review.reviewInput.kind} from ${review.reviewInput.source} ` +
      `(fingerprint ${shortFingerprint(review.reviewInput.fingerprint)}…)`
  );
  lines.push(`Run ID: ${review.runId}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Local writes
// ---------------------------------------------------------------------------

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertRunId(runId: string): void {
  if (runId === "." || runId === ".." || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
}

/** Sibling-temp-file + fsync + rename: never partially overwrite `path`. */
function atomicWriteFile(path: string, body: string): void {
  const tmpPath = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Resolve `outputFile` beneath `workspaceDir`: reject an empty/NUL-containing
 * path and reject any path whose lexical resolution escapes the workspace
 * (whether given as absolute or via `..` traversal). Returns the absolute
 * write target and its workspace-relative POSIX path.
 */
function resolveOutputFile(
  workspaceDir: string,
  outputFile: string
): { abs: string; rel: string } {
  if (outputFile === "" || outputFile.includes("\0")) {
    throw new Error("output file path is invalid");
  }
  const abs = isAbsolute(outputFile)
    ? outputFile
    : join(workspaceDir, outputFile);
  const rel = relative(workspaceDir, abs);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `output file escapes the operator workspace: ${JSON.stringify(outputFile)}`
    );
  }
  return { abs, rel: toPosix(rel) };
}

/**
 * Write the canonical Markdown atomically to `.otto/runs/<run-id>/review.md`
 * (always retained — the durable artifact every later task/idempotency check
 * reads back), and, when `outputFile` is given, atomically copy it there too.
 * `outputFile` MUST resolve beneath `workspaceDir` (no absolute escape, no
 * `..` traversal) and its workspace-relative path must clear
 * {@link checkWritePath} against the repo's `.otto/policy.json` — a
 * `allowedWriteRoots` restriction on write tools also gates this local copy.
 */
export function writeCanonicalReview(opts: {
  workspaceDir: string;
  runId: string;
  markdown: string;
  outputFile?: string;
}): { artifactPath: string; copiedPath?: string } {
  const { workspaceDir, runId, markdown, outputFile } = opts;
  assertRunId(runId);

  const dir = join(workspaceDir, ".otto", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, "review.md");
  atomicWriteFile(finalPath, markdown);
  const artifactPath = `.otto/runs/${runId}/review.md`;

  if (outputFile === undefined) {
    return { artifactPath };
  }

  const { abs, rel } = resolveOutputFile(workspaceDir, outputFile);
  const policy = readSafetyPolicy(workspaceDir);
  const violations = checkWritePath(policy, rel);
  if (violations.length > 0) {
    throw new Error(
      `output file rejected by write policy: ${violations.map((v) => v.message).join("; ")}`
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteFile(abs, markdown);

  return { artifactPath, copiedPath: rel };
}
