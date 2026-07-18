/**
 * Pure P32 domain types for automated pull-request code review: the revision
 * identity, eligibility rule, and severity→outcome mapping. No I/O, no GitHub,
 * no model calls — those land in later P32 tasks. See review-cli.ts for the
 * flag/config resolution that feeds this domain.
 */
import type { Finding } from "./review-severity.js";

/** A snapshot of a PR at a given head commit, as fetched from GitHub. */
export type PullRequestRevision = {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  labels: string[];
  baseRefName: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
};

/** The review verdict, derived from the highest-severity finding present. */
export type PullRequestReviewOutcome =
  | "changes-requested"
  | "comment"
  | "approved";

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Stable key identifying a specific (revision, input) review attempt, for
 * dedup/idempotency bookkeeping: `owner/repo#number@headSha:fingerprint`.
 * `inputFingerprint` must be a 64-character lower-case hex digest (e.g. a
 * sha256 of the resolved review input); anything else throws.
 */
export function revisionKey(
  revision: Pick<PullRequestRevision, "repository" | "number" | "headSha">,
  inputFingerprint: string
): string {
  if (!FINGERPRINT_RE.test(inputFingerprint)) {
    throw new Error(
      `inputFingerprint must be a 64-character lower-case hex string, got: ${JSON.stringify(inputFingerprint)}`
    );
  }
  return `${revision.repository}#${revision.number}@${revision.headSha}:${inputFingerprint}`;
}

/**
 * Why a PR is not eligible for automated review: `null` means eligible.
 * Priority: closed/merged > draft > missing the required label.
 */
export function ineligibleReason(
  revision: PullRequestRevision,
  label: string
): "closed" | "draft" | "label-missing" | null {
  if (revision.state !== "OPEN") return "closed";
  if (revision.isDraft) return "draft";
  if (!revision.labels.includes(label)) return "label-missing";
  return null;
}

/**
 * Deterministic outcome from a set of findings: any blocker/major requests
 * changes; otherwise any minor/nit is a comment; no findings at all approves.
 */
export function outcomeForFindings(
  findings: readonly Finding[]
): PullRequestReviewOutcome {
  if (
    findings.some((f) => f.severity === "blocker" || f.severity === "major")
  ) {
    return "changes-requested";
  }
  if (findings.length > 0) return "comment";
  return "approved";
}
