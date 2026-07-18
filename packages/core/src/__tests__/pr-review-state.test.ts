import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reviewStatePath,
  readReviewState,
  writeReviewState,
  claimRevision,
  heartbeatClaim,
  releaseClaim,
  isStateRunnable,
  REVIEW_LEASE_HEARTBEAT_MS,
  REVIEW_LEASE_STALE_MS,
  type PullRequestReviewState,
} from "../pr-review-state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "Owner/Repo";
const PR = 42;
const HEAD = "a".repeat(40);
const FP = "b".repeat(64);
const RUN = "run-123";

const T0 = new Date("2026-07-18T00:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const STATUSES: PullRequestReviewState["status"][] = [
  "running",
  "analysis-failed",
  "publish-failed",
  "succeeded",
  "superseded",
  "cancelled",
];

function baseState(
  over: Partial<PullRequestReviewState> = {}
): PullRequestReviewState {
  return {
    repository: REPO,
    pullRequest: PR,
    headSha: HEAD,
    inputFingerprint: FP,
    status: "running",
    runId: RUN,
    outputs: {},
    attempts: 1,
    updatedAt: T0.toISOString(),
    ...over,
  };
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-review-state-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path + persistence
// ---------------------------------------------------------------------------

describe("reviewStatePath", () => {
  it("is exactly the composite layout with lower-cased owner/repo", () => {
    expect(reviewStatePath(ws, REPO, PR, HEAD, FP)).toBe(
      join(
        ws,
        ".otto",
        "review-state",
        "github",
        "owner",
        "repo",
        "42",
        HEAD,
        `${FP}.json`
      )
    );
  });

  it("gives a new head SHA or changed fingerprint an independent path", () => {
    const p1 = reviewStatePath(ws, REPO, PR, HEAD, FP);
    const p2 = reviewStatePath(ws, REPO, PR, "c".repeat(40), FP);
    const p3 = reviewStatePath(ws, REPO, PR, HEAD, "d".repeat(64));
    expect(new Set([p1, p2, p3]).size).toBe(3);
  });

  it("rejects a bad repository / PR / SHA / fingerprint before disk I/O", () => {
    expect(() => reviewStatePath(ws, "no-slash", PR, HEAD, FP)).toThrow();
    expect(() => reviewStatePath(ws, "../etc/x", PR, HEAD, FP)).toThrow();
    expect(() => reviewStatePath(ws, REPO, 0, HEAD, FP)).toThrow();
    expect(() => reviewStatePath(ws, REPO, PR, "xyz", FP)).toThrow();
    expect(() => reviewStatePath(ws, REPO, PR, HEAD, "B".repeat(64))).toThrow();
    expect(() => reviewStatePath(ws, REPO, PR, HEAD, "b".repeat(63))).toThrow();
  });
});

describe("writeReviewState / readReviewState", () => {
  it("round-trips every status", () => {
    for (const status of STATUSES) {
      const state = baseState({ status });
      writeReviewState(ws, state);
      expect(readReviewState(ws, REPO, PR, HEAD, FP)).toEqual(state);
    }
  });

  it("returns null for an absent state", () => {
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const p = reviewStatePath(ws, REPO, PR, HEAD, FP);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "{ not json");
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();
  });

  it("returns null when the stored fingerprint does not match its path", () => {
    const p = reviewStatePath(ws, REPO, PR, HEAD, FP);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(baseState({ inputFingerprint: "e".repeat(64) }))
    );
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();
  });

  it("returns null when repository/PR/head in the record disagree with the path", () => {
    const p = reviewStatePath(ws, REPO, PR, HEAD, FP);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(baseState({ pullRequest: 99 })));
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();
  });

  it("accepts a canonical analysisArtifact but rejects any other path", () => {
    const good = baseState({
      analysisArtifact: `.otto/runs/${RUN}/analysis.json`,
    });
    writeReviewState(ws, good);
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toEqual(good);

    const p = reviewStatePath(ws, REPO, PR, HEAD, FP);
    writeFileSync(
      p,
      JSON.stringify(baseState({ analysisArtifact: ".otto/runs/other/x.json" }))
    );
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();

    writeFileSync(
      p,
      JSON.stringify(baseState({ analysisArtifact: "/etc/passwd" }))
    );
    expect(readReviewState(ws, REPO, PR, HEAD, FP)).toBeNull();
  });

  it("writes atomically: valid JSON, no leftover temp files", () => {
    writeReviewState(ws, baseState());
    const dir = join(reviewStatePath(ws, REPO, PR, HEAD, FP), "..");
    const entries = readdirSync(dir);
    expect(entries).toEqual([`${FP}.json`]);
    expect(() =>
      JSON.parse(readFileSync(reviewStatePath(ws, REPO, PR, HEAD, FP), "utf8"))
    ).not.toThrow();
  });

  it("validates identity before writing", () => {
    expect(() =>
      writeReviewState(ws, baseState({ runId: "bad id!" }))
    ).toThrow();
    expect(() =>
      writeReviewState(ws, baseState({ headSha: "nope" }))
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Atomic claim / lease
// ---------------------------------------------------------------------------

const claimOpts = (over: Record<string, unknown> = {}) => ({
  workspaceDir: ws,
  repository: REPO,
  pullRequest: PR,
  headSha: HEAD,
  inputFingerprint: FP,
  runId: RUN,
  pid: 1000,
  now: T0,
  ...over,
});

describe("claimRevision", () => {
  it("first exclusive create wins, a second live attempt is busy", () => {
    const first = claimRevision(claimOpts());
    expect(first.acquired).toBe(true);

    const second = claimRevision(claimOpts({ runId: "run-other" }));
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("busy");
      expect(second.claim.runId).toBe(RUN);
    }
  });

  it("acquires independently for two fingerprints on the same head SHA", () => {
    const a = claimRevision(claimOpts());
    const b = claimRevision(
      claimOpts({ inputFingerprint: "f".repeat(64), runId: "run-2" })
    );
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("keeps a fresh (<15 min) claim busy — it cannot be stolen", () => {
    claimRevision(claimOpts());
    const steal = claimRevision(claimOpts({ runId: "thief", now: at(14) }));
    expect(steal.acquired).toBe(false);
  });

  it("recovers a >15-minute stale claim atomically", () => {
    claimRevision(claimOpts());
    const recovered = claimRevision(
      claimOpts({ runId: "recoverer", now: at(16) })
    );
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) {
      expect(recovered.claim.runId).toBe("recoverer");
      expect(recovered.claim.heartbeatAt).toBe(at(16).toISOString());
    }
    // No tombstone left behind.
    const dir = join(reviewStatePath(ws, REPO, PR, HEAD, FP), "..");
    expect(readdirSync(dir).some((e) => e.includes(".stale-"))).toBe(false);
  });

  it("lets only one of two stale-recovery attempts acquire", () => {
    claimRevision(claimOpts());
    const first = claimRevision(claimOpts({ runId: "r1", now: at(16) }));
    const second = claimRevision(claimOpts({ runId: "r2", now: at(16) }));
    expect(first.acquired).toBe(true);
    // The first recovery installed a fresh claim, so the second sees it live.
    expect(second.acquired).toBe(false);
  });

  it("rejects a bad runId before disk I/O", () => {
    expect(() => claimRevision(claimOpts({ runId: "bad id!" }))).toThrow();
  });
});

describe("heartbeatClaim", () => {
  it("refreshes heartbeatAt only for a matching run ID", () => {
    const acq = claimRevision(claimOpts());
    if (!acq.acquired) throw new Error("expected acquire");

    expect(
      heartbeatClaim({ workspaceDir: ws, claim: acq.claim, now: at(14) })
    ).toBe(true);

    // A mismatched run ID is refused.
    expect(
      heartbeatClaim({
        workspaceDir: ws,
        claim: { ...acq.claim, runId: "nope" },
        now: at(14),
      })
    ).toBe(false);

    // The refresh kept the claim alive past what would otherwise be stale.
    const busy = claimRevision(claimOpts({ runId: "thief", now: at(20) }));
    expect(busy.acquired).toBe(false);
    if (!busy.acquired) {
      expect(busy.claim.heartbeatAt).toBe(at(14).toISOString());
    }
  });

  it("returns false when there is no claim", () => {
    const acq = claimRevision(claimOpts());
    if (!acq.acquired) throw new Error("expected acquire");
    releaseClaim({ workspaceDir: ws, claim: acq.claim });
    expect(
      heartbeatClaim({ workspaceDir: ws, claim: acq.claim, now: at(1) })
    ).toBe(false);
  });
});

describe("releaseClaim", () => {
  it("removes only a matching claim", () => {
    const acq = claimRevision(claimOpts());
    if (!acq.acquired) throw new Error("expected acquire");

    expect(
      releaseClaim({
        workspaceDir: ws,
        claim: { ...acq.claim, runId: "nope" },
      })
    ).toBe(false);
    // Still held.
    expect(claimRevision(claimOpts({ runId: "x" })).acquired).toBe(false);

    expect(releaseClaim({ workspaceDir: ws, claim: acq.claim })).toBe(true);
    // Now free.
    expect(claimRevision(claimOpts({ runId: "x" })).acquired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runnability
// ---------------------------------------------------------------------------

describe("isStateRunnable", () => {
  it("treats an absent state as runnable", () => {
    expect(isStateRunnable(null, T0)).toBe(true);
  });

  it("is not runnable when succeeded", () => {
    expect(isStateRunnable(baseState({ status: "succeeded" }), T0)).toBe(false);
  });

  it("is not runnable for a permanent (non-retryable) failure", () => {
    expect(isStateRunnable(baseState({ status: "analysis-failed" }), T0)).toBe(
      false
    );
    expect(
      isStateRunnable(
        baseState({ status: "publish-failed", retryable: false }),
        T0
      )
    ).toBe(false);
  });

  it("treats running / superseded / cancelled as runnable", () => {
    expect(isStateRunnable(baseState({ status: "running" }), T0)).toBe(true);
    expect(isStateRunnable(baseState({ status: "superseded" }), T0)).toBe(true);
    expect(isStateRunnable(baseState({ status: "cancelled" }), T0)).toBe(true);
  });

  it("makes a retryable failure runnable only at/after nextRetryAt", () => {
    const state = baseState({
      status: "publish-failed",
      retryable: true,
      nextRetryAt: at(5).toISOString(),
    });
    expect(isStateRunnable(state, at(4))).toBe(false);
    expect(isStateRunnable(state, at(5))).toBe(true);
    expect(isStateRunnable(state, at(6))).toBe(true);
  });
});

describe("lease timing constants", () => {
  it("matches the brief", () => {
    expect(REVIEW_LEASE_HEARTBEAT_MS).toBe(60_000);
    expect(REVIEW_LEASE_STALE_MS).toBe(15 * 60_000);
  });
});
