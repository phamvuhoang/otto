import {
  existsSync,
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
  acquireReviewLease,
  isStateRunnable,
  REVIEW_LEASE_HEARTBEAT_MS,
  REVIEW_LEASE_STALE_MS,
  type ReviewLease,
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
// Ownership-fenced PID-liveness lease
// ---------------------------------------------------------------------------

const leaseOpts = (over: Record<string, unknown> = {}) => ({
  workspaceDir: ws,
  repository: REPO,
  pullRequest: PR,
  headSha: HEAD,
  inputFingerprint: FP,
  runId: RUN,
  ...over,
});

/** The on-disk claim file path for a composite identity. */
function claimFile(repository = REPO, pr = PR, head = HEAD, fp = FP): string {
  return reviewStatePath(ws, repository, pr, head, fp).replace(
    /\.json$/,
    ".claim"
  );
}

/** A pid that our injected `isPidAlive` will treat as DEAD (never our own). */
const DEAD_PID = 999_999_999;
/** Real liveness: only THIS process is alive; any other recorded pid is dead. */
const onlySelfAlive = (pid: number) => pid === process.pid;

let held: ReviewLease[] = [];
afterEach(() => {
  for (const lease of held) lease.release();
  held = [];
});
function acquire(over: Record<string, unknown> = {}) {
  const res = acquireReviewLease(leaseOpts(over));
  if (res.acquired) held.push(res.lease);
  return res;
}

describe("acquireReviewLease", () => {
  it("acquires a free identity and writes its claim file", () => {
    const res = acquire();
    expect(res.acquired).toBe(true);
    if (res.acquired) {
      expect(typeof res.lease.release).toBe("function");
      expect(typeof res.lease.ownsClaim).toBe("function");
      expect(res.lease.ownsClaim()).toBe(true);
    }
    expect(existsSync(claimFile())).toBe(true);
    expect(readdirSync(join(claimFile(), ".."))).toContain(`${FP}.claim`);
  });

  it("a second acquire while the holder's pid is ALIVE is rejected as busy", () => {
    const first = acquire();
    expect(first.acquired).toBe(true);

    // The holder's recorded pid is our own (alive) → a live holder is never
    // dispossessed.
    const second = acquireReviewLease(leaseOpts({ runId: "run-other" }));
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe("busy");
  });

  it("acquires independently for two fingerprints on the same head SHA", () => {
    const a = acquire();
    const b = acquire({ inputFingerprint: "f".repeat(64), runId: "run-2" });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("a claim whose recorded pid is DEAD is recoverable by exactly one taker", () => {
    // Write a stale claim carrying a dead pid (a crashed holder).
    mkdirSync(join(claimFile(), ".."), { recursive: true });
    writeFileSync(
      claimFile(),
      JSON.stringify({
        repository: REPO,
        pullRequest: PR,
        headSha: HEAD,
        inputFingerprint: FP,
        runId: "crashed",
        pid: DEAD_PID,
        acquiredAt: T0.toISOString(),
        heartbeatAt: T0.toISOString(),
      })
    );
    const recovered = acquire({
      runId: "recoverer",
      isPidAlive: onlySelfAlive,
    });
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) expect(recovered.lease.ownsClaim()).toBe(true);
  });

  it("two racing recoverers of a DEAD claim: exactly one wins (rename arbitration)", () => {
    mkdirSync(join(claimFile(), ".."), { recursive: true });
    writeFileSync(
      claimFile(),
      JSON.stringify({
        repository: REPO,
        pullRequest: PR,
        headSha: HEAD,
        inputFingerprint: FP,
        runId: "crashed",
        pid: DEAD_PID,
        acquiredAt: T0.toISOString(),
        heartbeatAt: T0.toISOString(),
      })
    );
    // A recovers the dead claim and writes a fresh LIVE claim; B then sees A's
    // live claim and is busy.
    const a = acquire({ runId: "A", isPidAlive: onlySelfAlive });
    const b = acquireReviewLease(
      leaseOpts({ runId: "B", isPidAlive: onlySelfAlive })
    );
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
  });

  it("release is ownership-fenced + idempotent", () => {
    const first = acquireReviewLease(leaseOpts());
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected acquire");

    const busy = acquireReviewLease(leaseOpts({ runId: "x" }));
    expect(busy.acquired).toBe(false);

    first.lease.release();
    // Idempotent: safe to call again in a finally.
    first.lease.release();
    expect(existsSync(claimFile())).toBe(false);

    const again = acquire({ runId: "x" });
    expect(again.acquired).toBe(true);
  });

  it("rejects a bad runId before touching disk", () => {
    expect(() => acquireReviewLease(leaseOpts({ runId: "bad id!" }))).toThrow();
  });

  it("treats a byte-EMPTY claim file as BUSY (mid-create), never stolen", () => {
    // A concurrent create-in-progress could momentarily expose an empty claim
    // file. A second acquirer must NOT read it as unparseable-and-stale and
    // steal it — that would reintroduce a transient double-hold. It is BUSY.
    mkdirSync(join(claimFile(), ".."), { recursive: true });
    writeFileSync(claimFile(), "");
    const res = acquireReviewLease(
      leaseOpts({ runId: "racer", isPidAlive: onlySelfAlive })
    );
    expect(res.acquired).toBe(false);
    if (!res.acquired) expect(res.reason).toBe("busy");
  });

  it("link-based exclusive create: complete claim, no temp leftover, busy when held", () => {
    const free = acquire();
    expect(free.acquired).toBe(true);

    // The claim file appears already containing its FULL content — a reader sees
    // a COMPLETE parseable claim, never an empty/partial intermediate.
    const parsed = JSON.parse(readFileSync(claimFile(), "utf8"));
    expect(parsed.runId).toBe(RUN);
    expect(parsed.pid).toBe(process.pid);

    // The link-based create leaves no temp file behind.
    expect(readdirSync(join(claimFile(), ".."))).toEqual([`${FP}.claim`]);

    // Still held by a live claim → a second acquire is busy (EEXIST gate).
    const busy = acquireReviewLease(leaseOpts({ runId: "other" }));
    expect(busy.acquired).toBe(false);
    if (!busy.acquired) expect(busy.reason).toBe("busy");
  });

  it("B recovers A's DEAD claim; A's stale release NEVER deletes B's claim; C is busy", () => {
    // A acquires normally.
    const a = acquireReviewLease(leaseOpts({ runId: "A" }));
    expect(a.acquired).toBe(true);
    if (!a.acquired) throw new Error("expected A to acquire");

    // A's process dies: rewrite A's claim to carry a DEAD pid (same runId "A", so
    // A's in-hand lease handle still believes it owns the claim).
    const aClaim = JSON.parse(readFileSync(claimFile(), "utf8"));
    writeFileSync(claimFile(), JSON.stringify({ ...aClaim, pid: DEAD_PID }));

    // B recovers A's dead claim (A's pid is dead; B's own pid is alive).
    const b = acquireReviewLease(
      leaseOpts({ runId: "B", isPidAlive: onlySelfAlive })
    );
    expect(b.acquired).toBe(true);
    if (!b.acquired) throw new Error("expected B to recover");
    held.push(b.lease);

    // A, holding its STALE lease handle, calls release() — the ownership fence
    // MUST NOT delete B's claim.
    a.lease.release();
    const after = JSON.parse(readFileSync(claimFile(), "utf8"));
    expect(after.runId).toBe("B");
    expect(b.lease.ownsClaim()).toBe(true);

    // C therefore sees B's LIVE claim and is BUSY — no double-holder.
    const c = acquireReviewLease(
      leaseOpts({ runId: "C", isPidAlive: onlySelfAlive })
    );
    expect(c.acquired).toBe(false);
    if (!c.acquired) expect(c.reason).toBe("busy");
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
