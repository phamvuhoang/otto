import { describe, expect, it } from "vitest";

import {
  githubReviewEvent,
  nextPublicationRetryAt,
  publishFormalReview,
  reconcilePublication,
  ReviewWriteAbortedError,
  upsertSummaryComment,
} from "../pr-review-publish.js";
import {
  GitHubPrError,
  type CreateGitHubReviewInput,
  type GitHubComment,
  type GitHubReview,
} from "../github-pr.js";
import {
  headMarker,
  inputMarker,
  renderFormalReviewBody,
  reviewMarker,
  summaryMarker,
  type CanonicalReview,
  type PublishedReviewFinding,
} from "../pr-review-output.js";
import type { ReviewSkillSelection } from "../pr-review-skill.js";
import type { PullRequestRevision } from "../pr-review.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "acme/widget";
const PR = 7;
const HEAD = "a".repeat(40);
const NEW_HEAD = "f".repeat(40);
const FP = "b".repeat(64);
const OTHER_FP = "c".repeat(64);
const LABEL = "otto-review";
const VIEWER = "otto-bot";

function revision(
  over: Partial<PullRequestRevision> = {}
): PullRequestRevision {
  return {
    repository: REPO,
    number: PR,
    url: "https://github.com/acme/widget/pull/7",
    title: "Add feature",
    body: "body",
    author: "octocat",
    state: "OPEN",
    isDraft: false,
    labels: [LABEL],
    baseRefName: "main",
    baseSha: "d".repeat(40),
    headSha: HEAD,
    changedFiles: ["src/app.ts"],
    ...over,
  };
}

/** Build a summary-comment body carrying the stable + head + input markers. */
function body(headSha: string, fp: string, extra = "canonical review"): string {
  return [
    summaryMarker(REPO, PR),
    headMarker(headSha),
    inputMarker(fp),
    "",
    extra,
  ].join("\n");
}

function comment(over: Partial<GitHubComment> = {}): GitHubComment {
  return {
    id: 100,
    body: "hello",
    author: VIEWER,
    url: "https://github.com/acme/widget/issues/7#comment-100",
    ...over,
  };
}

type Recorded = {
  list: number;
  viewer: number;
  create: Array<{ repository: string; pr: number; body: string }>;
  update: Array<{ repository: string; commentId: number; body: string }>;
};

function fakeGithub(opts: {
  viewerLogin?: string;
  comments?: GitHubComment[];
}) {
  const store = [...(opts.comments ?? [])];
  let nextId = 900;
  const calls: Recorded = { list: 0, viewer: 0, create: [], update: [] };
  const github = {
    viewer() {
      calls.viewer++;
      return { login: opts.viewerLogin ?? VIEWER };
    },
    listIssueComments() {
      calls.list++;
      return store.map((c) => ({ ...c }));
    },
    createIssueComment(repository: string, pr: number, text: string) {
      calls.create.push({ repository, pr, body: text });
      const c = comment({
        id: nextId++,
        body: text,
        author: opts.viewerLogin ?? VIEWER,
      });
      store.push(c);
      return c;
    },
    updateIssueComment(repository: string, commentId: number, text: string) {
      calls.update.push({ repository, commentId, body: text });
      const found = store.find((c) => c.id === commentId);
      if (!found) throw new Error(`no comment ${commentId}`);
      found.body = text;
      return { ...found };
    },
  };
  return { github, calls };
}

// ---------------------------------------------------------------------------
// reconcilePublication
// ---------------------------------------------------------------------------

describe("reconcilePublication", () => {
  it("publishable when the re-queried PR still matches (open, non-draft, labelled, same head)", () => {
    const r = reconcilePublication({
      expected: revision(),
      current: revision(),
      label: LABEL,
    });
    expect(r.publishable).toBe(true);
    if (r.publishable) expect(r.current.headSha).toBe(HEAD);
  });

  it("rejects a changed head SHA as superseded", () => {
    const r = reconcilePublication({
      expected: revision(),
      current: revision({ headSha: NEW_HEAD }),
      label: LABEL,
    });
    expect(r).toMatchObject({ publishable: false, status: "superseded" });
  });

  it("rejects a closed/merged PR as cancelled", () => {
    for (const state of ["CLOSED", "MERGED"] as const) {
      const r = reconcilePublication({
        expected: revision(),
        current: revision({ state }),
        label: LABEL,
      });
      expect(r).toMatchObject({ publishable: false, status: "cancelled" });
    }
  });

  it("rejects a draft PR as cancelled", () => {
    const r = reconcilePublication({
      expected: revision(),
      current: revision({ isDraft: true }),
      label: LABEL,
    });
    expect(r).toMatchObject({ publishable: false, status: "cancelled" });
  });

  it("rejects a PR that lost the exact label as cancelled", () => {
    const r = reconcilePublication({
      expected: revision(),
      current: revision({ labels: ["something-else"] }),
      label: LABEL,
    });
    expect(r).toMatchObject({ publishable: false, status: "cancelled" });
  });

  it("prioritizes a changed head over an ineligible state (superseded)", () => {
    const r = reconcilePublication({
      expected: revision(),
      current: revision({ headSha: NEW_HEAD, state: "CLOSED" }),
      label: LABEL,
    });
    expect(r).toMatchObject({ publishable: false, status: "superseded" });
  });
});

// ---------------------------------------------------------------------------
// upsertSummaryComment
// ---------------------------------------------------------------------------

describe("upsertSummaryComment", () => {
  const upsert = (github: ReturnType<typeof fakeGithub>["github"]) =>
    upsertSummaryComment({
      github,
      repository: REPO,
      pullRequest: PR,
      headSha: HEAD,
      inputFingerprint: FP,
      body: body(HEAD, FP),
    });

  it("(3) creates one comment when no owned marker exists", () => {
    const { github, calls } = fakeGithub({ comments: [] });
    const receipt = upsert(github);
    expect(receipt.action).toBe("created");
    expect(calls.create).toHaveLength(1);
    expect(calls.update).toHaveLength(0);
    expect(calls.create[0].body).toBe(body(HEAD, FP));
    // Marker/body passed literally through the adapter (assertion 8).
    expect(calls.create[0].body).toContain(summaryMarker(REPO, PR));
  });

  it("(2) marker matching is scoped to repo/PR and the viewer's own comment", () => {
    // An UNRELATED PR's marker present, plus the viewer's real marker.
    const foreign = comment({
      id: 1,
      author: VIEWER,
      body: `${summaryMarker("acme/other", 99)}\nnot this pr`,
    });
    const owned = comment({
      id: 2,
      author: VIEWER,
      body: body("e".repeat(40), OTHER_FP), // older head/input → update
    });
    const { github, calls } = fakeGithub({ comments: [foreign, owned] });
    const receipt = upsert(github);
    expect(receipt.action).toBe("updated");
    expect(receipt.commentId).toBe(2);
    expect(calls.update).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
  });

  it("(4) updates the SAME comment id when the owned marker has an older head", () => {
    const owned = comment({
      id: 55,
      author: VIEWER,
      body: body("e".repeat(40), FP), // older head, same input
    });
    const { github, calls } = fakeGithub({ comments: [owned] });
    const receipt = upsert(github);
    expect(receipt.action).toBe("updated");
    expect(receipt.commentId).toBe(55);
    expect(calls.update[0].commentId).toBe(55);
    expect(calls.update[0].body).toBe(body(HEAD, FP));
  });

  it("(4b) updates the SAME comment id when the owned marker has a different input fingerprint", () => {
    const owned = comment({
      id: 56,
      author: VIEWER,
      body: body(HEAD, OTHER_FP), // current head, different input
    });
    const { github, calls } = fakeGithub({ comments: [owned] });
    const receipt = upsert(github);
    expect(receipt.action).toBe("updated");
    expect(receipt.commentId).toBe(56);
  });

  it("(5) reuses without a write when head, input, and body are already current", () => {
    const owned = comment({ id: 77, author: VIEWER, body: body(HEAD, FP) });
    const { github, calls } = fakeGithub({ comments: [owned] });
    const receipt = upsert(github);
    expect(receipt.action).toBe("reused");
    expect(receipt.commentId).toBe(77);
    expect(calls.create).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
  });

  it("(6) never updates a malicious contributor's copied marker", () => {
    const attacker = comment({
      id: 8,
      author: "evil-user",
      body: body("e".repeat(40), OTHER_FP), // copied stale marker
    });
    const { github, calls } = fakeGithub({ comments: [attacker] });
    const receipt = upsert(github);
    // The attacker's comment is not owned → a fresh comment is created.
    expect(receipt.action).toBe("created");
    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(1);
  });

  it("(7) treats multiple owned marker comments as a permanent contract error", () => {
    const a = comment({ id: 10, author: VIEWER, body: body(HEAD, FP) });
    const b = comment({
      id: 11,
      author: VIEWER,
      body: body("e".repeat(40), OTHER_FP),
    });
    const { github, calls } = fakeGithub({ comments: [a, b] });
    try {
      upsert(github);
      expect.unreachable("expected a contract error");
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubPrError);
      expect((e as GitHubPrError).retryable).toBe(false);
    }
    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });

  it("(#2) runs ensureAuthorized at the write boundary — a create is NOT issued when it throws", () => {
    // The fence fires AFTER viewer()+list reconciliation but IMMEDIATELY before
    // the create write, so a caller shutdown during the helper's reads publishes
    // nothing.
    const { github, calls } = fakeGithub({ comments: [] });
    expect(() =>
      upsertSummaryComment({
        github,
        repository: REPO,
        pullRequest: PR,
        headSha: HEAD,
        inputFingerprint: FP,
        body: body(HEAD, FP),
        ensureAuthorized: () => {
          throw new ReviewWriteAbortedError("aborted at boundary");
        },
      })
    ).toThrow(ReviewWriteAbortedError);
    // The reads happened, but NO comment was created.
    expect(calls.viewer).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.create).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
  });

  it("(#2) runs ensureAuthorized at the write boundary — an update is NOT issued when it throws", () => {
    const owned = comment({
      id: 55,
      author: VIEWER,
      body: body("e".repeat(40), FP), // older head → would update
    });
    const { github, calls } = fakeGithub({ comments: [owned] });
    expect(() =>
      upsertSummaryComment({
        github,
        repository: REPO,
        pullRequest: PR,
        headSha: HEAD,
        inputFingerprint: FP,
        body: body(HEAD, FP),
        ensureAuthorized: () => {
          throw new ReviewWriteAbortedError("aborted at boundary");
        },
      })
    ).toThrow(ReviewWriteAbortedError);
    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Formal GitHub review (Task 14)
// ---------------------------------------------------------------------------

const SKILL: ReviewSkillSelection = {
  name: "builtin:otto-code-review",
  version: "1",
  source: "builtin",
  checksum: "deadbeef",
  injection: "",
  usage: {
    name: "builtin:otto-code-review",
    version: "1",
    source: "builtin",
    stage: "pr-review",
    checksum: "deadbeef",
  },
};

function pubFinding(
  over: Partial<PublishedReviewFinding> = {}
): PublishedReviewFinding {
  return {
    severity: "major",
    file: "src/app.ts",
    line: "10",
    claim: "off-by-one",
    why: "loop bound is wrong",
    lens: "correctness",
    inlineEligible: false,
    ...over,
  };
}

function canonical(over: Partial<CanonicalReview> = {}): CanonicalReview {
  return {
    repository: REPO,
    pullRequest: PR,
    url: "https://github.com/acme/widget/pull/7",
    title: "Add feature",
    baseSha: "d".repeat(40),
    headSha: HEAD,
    reviewInput: {
      kind: "prompt",
      source: "direct",
      fingerprint: FP,
      artifactPath: ".otto/runs/run-1/review-input.md",
    },
    runId: "run-1",
    outcome: "changes-requested",
    confirmed: [],
    rejectedCount: 0,
    suppressedCount: 0,
    skill: SKILL,
    diffArtifact: ".otto/runs/run-1/pr.diff",
    analysisArtifact: ".otto/runs/run-1/analysis.json",
    ...over,
  };
}

function review(over: Partial<GitHubReview> = {}): GitHubReview {
  return {
    id: 500,
    body: "looks good",
    author: VIEWER,
    commitId: HEAD,
    state: "APPROVED",
    ...over,
  };
}

function fakeReviewGithub(opts: {
  viewerLogin?: string;
  reviews?: GitHubReview[];
  createError?: Error;
}) {
  const store = [...(opts.reviews ?? [])];
  let nextId = 700;
  const calls = {
    viewer: 0,
    list: 0,
    create: [] as CreateGitHubReviewInput[],
  };
  const github = {
    viewer() {
      calls.viewer++;
      return { login: opts.viewerLogin ?? VIEWER };
    },
    listReviews() {
      calls.list++;
      return store.map((r) => ({ ...r }));
    },
    createReview(input: CreateGitHubReviewInput): GitHubReview {
      calls.create.push(input);
      if (opts.createError) throw opts.createError;
      const r = review({
        id: nextId++,
        body: input.body,
        author: opts.viewerLogin ?? VIEWER,
        commitId: input.commitId,
        state: input.event === "APPROVE" ? "APPROVED" : input.event,
      });
      store.push(r);
      return r;
    },
  };
  return { github, calls };
}

describe("githubReviewEvent", () => {
  it("(1) maps the deterministic outcome to a formal review event", () => {
    expect(githubReviewEvent("changes-requested")).toBe("REQUEST_CHANGES");
    expect(githubReviewEvent("comment")).toBe("COMMENT");
    expect(githubReviewEvent("approved")).toBe("APPROVE");
  });
});

describe("publishFormalReview", () => {
  it("(1) submits REQUEST_CHANGES for a blocker/major outcome", () => {
    const { github, calls } = fakeReviewGithub({});
    publishFormalReview({
      github,
      review: canonical({ outcome: "changes-requested" }),
    });
    expect(calls.create[0].event).toBe("REQUEST_CHANGES");
  });

  it("(1) submits APPROVE for a clean outcome and COMMENT for minor/nit", () => {
    const a = fakeReviewGithub({});
    publishFormalReview({
      github: a.github,
      review: canonical({ outcome: "approved" }),
    });
    expect(a.calls.create[0].event).toBe("APPROVE");
    const c = fakeReviewGithub({});
    publishFormalReview({
      github: c.github,
      review: canonical({ outcome: "comment" }),
    });
    expect(c.calls.create[0].event).toBe("COMMENT");
  });

  it("(2) body leads with the composite marker, provenance, and every unmappable finding", () => {
    const { github, calls } = fakeReviewGithub({});
    const rev = canonical({
      confirmed: [
        pubFinding({
          claim: "unmapped whole-file",
          file: "big.ts",
          inlineEligible: false,
        }),
      ],
    });
    publishFormalReview({ github, review: rev });
    const composite = reviewMarker(REPO, PR, HEAD, FP);
    const body = calls.create[0].body;
    expect(body.startsWith(composite)).toBe(true);
    expect(body).toContain(FP);
    expect(body).toContain("unmapped whole-file");
    expect(body).toBe(renderFormalReviewBody(rev));
  });

  it("(3) only mapped findings become inline comments; unmappable ones stay in the body", () => {
    const { github, calls } = fakeReviewGithub({});
    publishFormalReview({
      github,
      review: canonical({
        confirmed: [
          pubFinding({
            claim: "mapped bug",
            file: "src/app.ts",
            inlineEligible: true,
            side: "RIGHT",
            mappedLine: 12,
          }),
          pubFinding({
            claim: "whole-file",
            file: "src/app.ts",
            inlineEligible: false,
          }),
        ],
      }),
    });
    const comments = calls.create[0].comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      path: "src/app.ts",
      line: 12,
      side: "RIGHT",
    });
    expect(comments[0].body).toContain("mapped bug");
    // The unmappable finding is NOT an inline comment (it is in the body).
    expect(comments.some((c) => c.body.includes("whole-file"))).toBe(false);
  });

  it("(6) sends the exact head commit_id", () => {
    const { github, calls } = fakeReviewGithub({});
    publishFormalReview({ github, review: canonical() });
    expect(calls.create[0].commitId).toBe(HEAD);
    expect(calls.create[0].repository).toBe(REPO);
    expect(calls.create[0].pullRequest).toBe(PR);
  });

  it("(4/8) reuses an existing owned review for the exact head/input composite (no duplicate)", () => {
    const existing = review({
      id: 42,
      body: `${reviewMarker(REPO, PR, HEAD, FP)}\nprior formal review`,
    });
    const { github, calls } = fakeReviewGithub({ reviews: [existing] });
    const receipt = publishFormalReview({ github, review: canonical() });
    expect(receipt.action).toBe("reused");
    expect(receipt.reviewId).toBe(42);
    expect(calls.create).toHaveLength(0);
  });

  it("(4/8) does NOT reuse an owned review for an older head or a different input", () => {
    const olderHead = review({
      id: 43,
      body: `${reviewMarker(REPO, PR, "e".repeat(40), FP)}\nolder head`,
    });
    const otherInput = review({
      id: 44,
      body: `${reviewMarker(REPO, PR, HEAD, OTHER_FP)}\ndifferent input`,
    });
    const { github, calls } = fakeReviewGithub({
      reviews: [olderHead, otherInput],
    });
    const receipt = publishFormalReview({ github, review: canonical() });
    expect(receipt.action).toBe("created");
    expect(calls.create).toHaveLength(1);
  });

  it("(5) ignores a composite marker copied by another actor", () => {
    const forged = review({
      id: 66,
      author: "evil-contributor",
      body: `${reviewMarker(REPO, PR, HEAD, FP)}\nLGTM (forged)`,
    });
    const { github, calls } = fakeReviewGithub({ reviews: [forged] });
    const receipt = publishFormalReview({ github, review: canonical() });
    expect(receipt.action).toBe("created");
    expect(calls.create).toHaveLength(1);
  });

  it("(7) propagates a self-approval/422 as a permanent GitHubPrError", () => {
    const { github } = fakeReviewGithub({
      createError: new GitHubPrError(
        "Can not approve your own pull request (HTTP 422)",
        "validation",
        false,
        422
      ),
    });
    try {
      publishFormalReview({
        github,
        review: canonical({ outcome: "approved" }),
      });
      expect.unreachable("expected a permanent error");
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubPrError);
      expect((e as GitHubPrError).retryable).toBe(false);
    }
  });

  it("(10) treats multiple owned exact-composite reviews as a permanent reconciliation error", () => {
    const a = review({
      id: 1,
      body: `${reviewMarker(REPO, PR, HEAD, FP)}\none`,
    });
    const b = review({
      id: 2,
      body: `${reviewMarker(REPO, PR, HEAD, FP)}\ntwo`,
    });
    const { github, calls } = fakeReviewGithub({ reviews: [a, b] });
    try {
      publishFormalReview({ github, review: canonical() });
      expect.unreachable("expected a reconciliation error");
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubPrError);
      expect((e as GitHubPrError).retryable).toBe(false);
    }
    expect(calls.create).toHaveLength(0);
  });

  it("(#2) runs ensureAuthorized at the write boundary — createReview is NOT issued when it throws", () => {
    const { github, calls } = fakeReviewGithub({});
    expect(() =>
      publishFormalReview({
        github,
        review: canonical(),
        ensureAuthorized: () => {
          throw new ReviewWriteAbortedError("aborted at boundary");
        },
      })
    ).toThrow(ReviewWriteAbortedError);
    // Reconciliation reads ran, but NO review was created.
    expect(calls.viewer).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.create).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// nextPublicationRetryAt
// ---------------------------------------------------------------------------

describe("nextPublicationRetryAt", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("(9) uses bounded exponential delay: 60s, 120s, 240s, capped at 15m", () => {
    expect(nextPublicationRetryAt(1, now)).toBe(at(60_000));
    expect(nextPublicationRetryAt(2, now)).toBe(at(120_000));
    expect(nextPublicationRetryAt(3, now)).toBe(at(240_000));
    expect(nextPublicationRetryAt(4, now)).toBe(at(480_000));
    // 60s*2^4 = 960s > 15m cap → capped.
    expect(nextPublicationRetryAt(5, now)).toBe(at(15 * 60_000));
    expect(nextPublicationRetryAt(9, now)).toBe(at(15 * 60_000));
  });
});
