import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
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
// Ownership-atomic advisory lease (proper-lockfile)
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

/** The lock directory proper-lockfile creates for a composite identity. */
function lockDir(repository = REPO, pr = PR, head = HEAD, fp = FP): string {
  return (
    reviewStatePath(ws, repository, pr, head, fp).replace(/\.json$/, ".claim") +
    ".lock"
  );
}

/** Resolve once the signal aborts, or reject if it does not within `ms`. */
function awaitAbort(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("signal did not abort in time")),
      ms
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// Track leases acquired in a test so update timers are always torn down.
let held: ReviewLease[] = [];
afterEach(async () => {
  for (const lease of held) await lease.release();
  held = [];
});
async function acquire(over: Record<string, unknown> = {}) {
  const res = await acquireReviewLease(leaseOpts(over));
  if (res.acquired) held.push(res.lease);
  return res;
}

describe("acquireReviewLease", () => {
  it("acquires a free identity and creates its lock directory", async () => {
    const res = await acquire();
    expect(res.acquired).toBe(true);
    if (res.acquired) {
      expect(typeof res.lease.release).toBe("function");
      expect(res.lease.compromised).toBeInstanceOf(AbortSignal);
      expect(res.lease.compromised.aborted).toBe(false);
    }
    expect(readdirSync(join(lockDir(), ".."))).toContain(`${FP}.claim.lock`);
  });

  it("a second concurrent acquire on a LIVE lock is rejected as busy", async () => {
    const first = await acquire();
    expect(first.acquired).toBe(true);

    const second = await acquireReviewLease(leaseOpts({ runId: "run-other" }));
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe("busy");
  });

  it("acquires independently for two fingerprints on the same head SHA", async () => {
    const a = await acquire();
    const b = await acquire({
      inputFingerprint: "f".repeat(64),
      runId: "run-2",
    });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("recovers a STALE lock (crashed holder, no active refresh)", async () => {
    // Simulate a crashed holder: a lock directory whose mtime is far in the
    // past with nothing refreshing it (no in-memory updater).
    mkdirSync(join(lockDir(), ".."), { recursive: true });
    mkdirSync(lockDir());
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir(), old, old);

    const recovered = await acquire({ runId: "recoverer", staleMs: 2000 });
    expect(recovered.acquired).toBe(true);
  });

  it("releasing frees the identity for the next acquirer", async () => {
    const first = await acquireReviewLease(leaseOpts());
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected acquire");

    // While held it is busy.
    const busy = await acquireReviewLease(leaseOpts({ runId: "x" }));
    expect(busy.acquired).toBe(false);

    await first.lease.release();
    // release is idempotent (safe to call again in a finally).
    await first.lease.release();

    const again = await acquire({ runId: "x" });
    expect(again.acquired).toBe(true);
  });

  it("rejects a bad runId before touching disk", async () => {
    await expect(
      acquireReviewLease(leaseOpts({ runId: "bad id!" }))
    ).rejects.toThrow();
  });

  it("signals `compromised` when the lock is stolen out from under a holder", async () => {
    // Hold the lock with a fast refresh so the theft is detected quickly.
    const res = await acquire({ staleMs: 2000, updateMs: 1000 });
    expect(res.acquired).toBe(true);
    if (!res.acquired) throw new Error("expected acquire");
    expect(res.lease.compromised.aborted).toBe(false);

    // Another process stale-recovers us: the lock directory disappears.
    rmSync(lockDir(), { recursive: true, force: true });

    // The auto-refresh notices (ENOENT) and fires the compromise signal — this
    // is how a slow holder learns it must ABORT instead of clobbering.
    await awaitAbort(res.lease.compromised, 4000);
    expect(res.lease.compromised.aborted).toBe(true);
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
