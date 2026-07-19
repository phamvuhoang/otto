/**
 * State-aware publication reconciliation and idempotent summary-comment upsert
 * (P32 Task 12 — the FIRST GitHub WRITE path in the automated-review feature).
 *
 * Two harness-owned primitives make restart/retry safe:
 *
 *  - {@link reconcilePublication}: a pure re-query gate. Given the exact revision
 *    the analysis ran against (`expected`) and a freshly re-queried revision
 *    (`current`), it says whether the remote write may still proceed. A CHANGED
 *    head SHA is `superseded`; a closed/merged/draft/label-removed PR is
 *    `cancelled`. The pipeline calls this IMMEDIATELY before any write so a PR
 *    that moved on during analysis emits no stale remote output.
 *
 *  - {@link upsertSummaryComment}: the marker-based single-comment guarantee.
 *    Before creating, it re-queries existing comments and finds the one carrying
 *    THIS PR's stable {@link summaryMarker} AND authored by the viewer. If found
 *    it UPDATES that same comment id; otherwise it CREATES exactly one. This is
 *    what makes a restart with lost local state never duplicate a comment. A
 *    foreign copy of the marker (different author) is never touched, and finding
 *    more than one owned marker is a permanent contract error rather than an
 *    arbitrary overwrite.
 *
 * This module performs NO model work and issues NO command a model could emit —
 * every GitHub write goes through the typed adapter passed in by the pipeline.
 */

import { normalizeFindingPath } from "./pr-review-diff.js";
import {
  GitHubPrError,
  type CreateGitHubReviewInput,
  type GitHubComment,
  type GitHubPrClient,
  type GitHubReview,
} from "./github-pr.js";
import {
  headMarker,
  inputMarker,
  renderFormalReviewBody,
  renderInlineComment,
  reviewMarker,
  summaryMarker,
  type CanonicalReview,
} from "./pr-review-output.js";
import {
  ineligibleReason,
  type PullRequestReviewOutcome,
  type PullRequestRevision,
} from "./pr-review.js";

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** The re-query verdict just before a remote write. */
export type PublicationReconciliation =
  | { publishable: true; current: PullRequestRevision }
  | {
      publishable: false;
      status: "superseded" | "cancelled";
      current: PullRequestRevision;
      reason: string;
    };

/**
 * Decide whether a completed analysis may still publish to the live PR. A moved
 * head takes priority (the analysis reviewed a now-stale revision → superseded);
 * otherwise a PR that is closed/merged, converted to draft, or has lost the
 * exact required label is cancelled. Anything else is publishable.
 */
export function reconcilePublication(opts: {
  expected: PullRequestRevision;
  current: PullRequestRevision;
  label: string;
}): PublicationReconciliation {
  const { expected, current, label } = opts;

  if (current.headSha !== expected.headSha) {
    return {
      publishable: false,
      status: "superseded",
      current,
      reason: `the PR head advanced to ${current.headSha} during review`,
    };
  }

  const reason = ineligibleReason(current, label);
  if (reason === "closed") {
    return {
      publishable: false,
      status: "cancelled",
      current,
      reason: "the pull request is no longer open",
    };
  }
  if (reason === "draft") {
    return {
      publishable: false,
      status: "cancelled",
      current,
      reason: "the pull request was converted to draft",
    };
  }
  if (reason === "label-missing") {
    return {
      publishable: false,
      status: "cancelled",
      current,
      reason: `the required label "${label}" was removed`,
    };
  }

  return { publishable: true, current };
}

// ---------------------------------------------------------------------------
// Zero / one / many owned-marker reconciliation
// ---------------------------------------------------------------------------

/**
 * Resolve the SINGLE owned item from a list under an ownership predicate:
 *
 *  - zero owned → `null`;
 *  - exactly one owned → that item;
 *  - more than one owned → a permanent {@link GitHubPrError} (`"validation"`,
 *    non-retryable) built from `onConflict(count)` — refusing to arbitrarily
 *    pick one.
 *
 * The publish helpers AND remote-proof recovery all reconcile owned markers
 * through this one helper so a `>1` marker is never silently accepted anywhere.
 */
export function resolveOwnedUnique<T>(
  items: readonly T[],
  isOwned: (item: T) => boolean,
  onConflict: (count: number) => string
): T | null {
  const owned = items.filter(isOwned);
  if (owned.length > 1) {
    throw new GitHubPrError(onConflict(owned.length), "validation", false);
  }
  return owned.length === 1 ? owned[0] : null;
}

// ---------------------------------------------------------------------------
// Idempotent summary-comment upsert
// ---------------------------------------------------------------------------

/** The outcome of an {@link upsertSummaryComment} call. */
export type SummaryCommentReceipt = {
  commentId: number;
  action: "created" | "updated" | "reused";
  body: string;
};

/**
 * Create-or-update this PR's single Otto summary comment idempotently.
 *
 * Reconciliation is by MARKER, not by any locally remembered comment id, so a
 * run that lost its local state still finds and reuses the existing comment
 * instead of duplicating it:
 *
 *  - an owned marker is a comment authored by `github.viewer().login` whose body
 *    contains this PR's stable {@link summaryMarker} (scoped to repo/PR);
 *  - zero owned markers → CREATE exactly one comment;
 *  - exactly one owned marker whose body already equals the new body AND already
 *    carries the current head + input markers → REUSE with no write;
 *  - exactly one owned marker otherwise (older head or different input) → UPDATE
 *    that same comment id;
 *  - more than one owned marker → a permanent {@link GitHubPrError} (never an
 *    arbitrary overwrite);
 *  - a foreign copy of the marker (any other author) is ignored entirely.
 */
export function upsertSummaryComment(opts: {
  github: Pick<
    GitHubPrClient,
    "viewer" | "listIssueComments" | "createIssueComment" | "updateIssueComment"
  >;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  body: string;
}): SummaryCommentReceipt {
  const { github, repository, pullRequest, headSha, inputFingerprint, body } =
    opts;

  const marker = summaryMarker(repository, pullRequest);
  const viewer = github.viewer();
  const comments = github.listIssueComments(repository, pullRequest);

  const existing: GitHubComment | null = resolveOwnedUnique(
    comments,
    (c) => c.author === viewer.login && c.body.includes(marker),
    (count) =>
      `found ${count} Otto summary comments carrying ${marker} on ` +
      `${repository}#${pullRequest}; refusing to guess which to update — ` +
      `remove the duplicates so a single owned comment remains`
  );

  if (existing === null) {
    const created = github.createIssueComment(repository, pullRequest, body);
    return { commentId: created.id, action: "created", body };
  }

  const currentHead = headMarker(headSha);
  const currentInput = inputMarker(inputFingerprint);
  if (
    existing.body === body &&
    existing.body.includes(currentHead) &&
    existing.body.includes(currentInput)
  ) {
    return { commentId: existing.id, action: "reused", body: existing.body };
  }

  const updated = github.updateIssueComment(repository, existing.id, body);
  return { commentId: updated.id, action: "updated", body };
}

// ---------------------------------------------------------------------------
// Formal (native) GitHub review
// ---------------------------------------------------------------------------

/** The outcome of a {@link publishFormalReview} call. */
export type FormalReviewReceipt = {
  reviewId: number;
  action: "created" | "reused";
  body: string;
};

/**
 * The deterministic native-review event for a review outcome: any blocker/major
 * requests changes, a minor/nit-only review comments, and a clean review
 * approves — mirroring {@link outcomeForFindings}.
 */
export function githubReviewEvent(
  outcome: PullRequestReviewOutcome
): CreateGitHubReviewInput["event"] {
  switch (outcome) {
    case "changes-requested":
      return "REQUEST_CHANGES";
    case "comment":
      return "COMMENT";
    case "approved":
      return "APPROVE";
  }
}

/**
 * Submit EXACTLY ONE formal GitHub review per `(repo, PR, headSha, input)`
 * composite identity, idempotently by MARKER (never by locally remembered id):
 *
 *  - an owned review is one authored by `github.viewer().login` whose body
 *    carries THIS composite {@link reviewMarker};
 *  - zero owned reviews → CREATE one review (deterministic event, the composite
 *    marker + provenance + every unmappable finding in the body, and one inline
 *    comment per mappable finding at its exact path/line/side);
 *  - exactly one owned review → REUSE it (no write) — this is what makes a
 *    restart/retry never post a duplicate for the same composite identity;
 *  - more than one owned review → a permanent {@link GitHubPrError} (a
 *    reconciliation error, never an arbitrary reuse);
 *  - a foreign copy of the composite marker (any other author) is ignored, and
 *    an older head or a different input fingerprint is a DIFFERENT composite
 *    marker string, so it never matches (a changed input intentionally permits
 *    a new review on the same head).
 *
 * A create failure (e.g. GitHub refusing self-approval, HTTP 422) propagates as
 * the underlying permanent {@link GitHubPrError}; the caller records it as a
 * visible `publish-failed` without discarding any already-succeeded receipt.
 */
export function publishFormalReview(opts: {
  github: Pick<GitHubPrClient, "viewer" | "listReviews" | "createReview">;
  review: CanonicalReview;
}): FormalReviewReceipt {
  const { github, review } = opts;
  const { repository, pullRequest, headSha } = review;
  const marker = reviewMarker(
    repository,
    pullRequest,
    headSha,
    review.reviewInput.fingerprint
  );
  const viewer = github.viewer();
  const reviews = github.listReviews(repository, pullRequest);

  const owned: GitHubReview | null = resolveOwnedUnique(
    reviews,
    (r) => r.author === viewer.login && r.body.includes(marker),
    (count) =>
      `found ${count} Otto formal reviews carrying ${marker} on ` +
      `${repository}#${pullRequest}; refusing to guess which represents this ` +
      `review — remove the duplicates so a single owned review remains`
  );

  if (owned !== null) {
    return { reviewId: owned.id, action: "reused", body: owned.body };
  }

  const body = renderFormalReviewBody(review);
  const comments = review.confirmed
    .filter(
      (f) =>
        f.inlineEligible &&
        f.side !== undefined &&
        typeof f.mappedLine === "number"
    )
    .map((f) => ({
      path: normalizeFindingPath(f.file),
      line: f.mappedLine as number,
      side: f.side as "LEFT" | "RIGHT",
      body: renderInlineComment(f),
    }));

  const created = github.createReview({
    repository,
    pullRequest,
    commitId: headSha,
    event: githubReviewEvent(review.outcome),
    body,
    comments,
  });
  return { reviewId: created.id, action: "created", body };
}

// ---------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------

/** First backoff step and the cap for {@link nextPublicationRetryAt}. */
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 15 * 60_000;

/**
 * The next-eligible timestamp for a transient publication failure: a bounded
 * exponential backoff of 60s, 120s, 240s, … capped at 15 minutes. `attempts` is
 * the number of failed attempts so far (1 → 60s).
 */
export function nextPublicationRetryAt(
  attempts: number,
  now: Date = new Date()
): string {
  const exp = Math.max(0, Math.floor(attempts) - 1);
  const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exp);
  return new Date(now.getTime() + delay).toISOString();
}
