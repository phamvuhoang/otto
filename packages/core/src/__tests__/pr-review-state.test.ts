import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockSync } from "fs-ext";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reviewStatePath,
  readReviewState,
  writeReviewState,
  acquireReviewLease,
  isStateRunnable,
  _resolveFlockSync,
  _setFlockSyncForTest,
  ReviewLeaseError,
  type FlockSyncFn,
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
// OS flock (advisory-lock) lease
//
// The lease is a real kernel-serialized `flock` held on an open fd for the run's
// lifetime. Two independent open file descriptions cannot both take the
// exclusive lock, so two acquirers can NEVER both get `acquired: true` — the
// exact double-hold the old read-decide-takeover claim scheme could not close.
// The kernel auto-releases the lock when the holding fd closes or the process
// dies, so crash recovery needs no PID probe, tombstone, or staleness logic.
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

/** The on-disk lock file path for a composite identity. */
function lockFile(repository = REPO, pr = PR, head = HEAD, fp = FP): string {
  return reviewStatePath(ws, repository, pr, head, fp).replace(
    /\.json$/,
    ".lock"
  );
}

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
  it("acquires a free identity, holds the lock, and reports ownership", () => {
    const res = acquire();
    expect(res.acquired).toBe(true);
    if (res.acquired) {
      expect(typeof res.lease.release).toBe("function");
      expect(typeof res.lease.ownsClaim).toBe("function");
      expect(res.lease.ownsClaim()).toBe(true);
    }
    expect(existsSync(lockFile())).toBe(true);
  });

  it("a SECOND acquire while the first still holds the flock is busy — two independent holders can NEVER both acquire", () => {
    // This is the exact double-hold the old read-decide-takeover claim scheme
    // could not close. `acquireReviewLease` opens its OWN fd each call, so these
    // are two independent open file descriptions; the kernel serializes the
    // exclusive flock and the second acquirer is rejected outright.
    const first = acquire();
    expect(first.acquired).toBe(true);

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

  it("release frees the lock so a subsequent acquire succeeds", () => {
    const first = acquireReviewLease(leaseOpts());
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected acquire");

    const busy = acquireReviewLease(leaseOpts({ runId: "x" }));
    expect(busy.acquired).toBe(false);

    first.lease.release();

    const again = acquire({ runId: "x" });
    expect(again.acquired).toBe(true);
  });

  it("release keeps the lock FILE on disk (never unlinks it) so exclusion survives", () => {
    // Unlinking a flock'd lock file is the classic footgun: it decouples future
    // acquirers onto a fresh inode (path→new inode via O_CREAT) whose flock is
    // independent of any inode a prior acquirer still holds → double-acquire. The
    // file MUST persist so every acquirer opens the same path → same inode →
    // contends on the SAME kernel lock.
    const first = acquireReviewLease(leaseOpts());
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected acquire");

    first.lease.release();

    // The persistent lock file survives release…
    expect(existsSync(lockFile())).toBe(true);
    // …and a subsequent acquire re-locks that same inode at the same path.
    const again = acquire({ runId: "next" });
    expect(again.acquired).toBe(true);
  });

  it("release is idempotent and ownsClaim is false afterwards", () => {
    const first = acquireReviewLease(leaseOpts());
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected acquire");
    expect(first.lease.ownsClaim()).toBe(true);

    first.lease.release();
    // Safe to call again in a finally.
    first.lease.release();
    expect(first.lease.ownsClaim()).toBe(false);
  });

  it("crash recovery is automatic: the kernel releases a dead holder's lock on fd close", () => {
    // Simulate a crashed daemon that still holds the OS lock: open the lock file
    // on a raw fd and take the exclusive flock ourselves.
    mkdirSync(join(lockFile(), ".."), { recursive: true });
    const crashedFd = openSync(lockFile(), "a");
    flockSync(crashedFd, "exnb");

    // While that "process" holds the lock, a fresh acquire is busy.
    const busy = acquireReviewLease(leaseOpts({ runId: "restart" }));
    expect(busy.acquired).toBe(false);
    if (!busy.acquired) expect(busy.reason).toBe("busy");

    // The daemon "crashes": closing its fd makes the kernel release the flock —
    // no PID probe, tombstone, or staleness logic is involved.
    closeSync(crashedFd);

    // The restart's exclusive flock simply succeeds.
    const recovered = acquire({ runId: "restart" });
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) expect(recovered.lease.ownsClaim()).toBe(true);
  });

  it("a stale lock FILE left on disk with no live holder is freely acquirable (file content is not the authority)", () => {
    // After a crash the lock FILE may survive, possibly holding stale evidence.
    // With flock the file content is NOT the authority — nothing parses it for a
    // pid or staleness. An unlocked file is simply acquirable.
    mkdirSync(join(lockFile(), ".."), { recursive: true });
    writeFileSync(
      lockFile(),
      JSON.stringify({ runId: "crashed", pid: 999_999_999 })
    );
    const res = acquire({ runId: "fresh" });
    expect(res.acquired).toBe(true);
    if (res.acquired) expect(res.lease.ownsClaim()).toBe(true);
  });

  it("rejects a bad runId before touching disk", () => {
    expect(() => acquireReviewLease(leaseOpts({ runId: "bad id!" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real (non-busy) flock CALL failures — must be wrapped in an actionable error
//
// `getFlockSync()` only gives an actionable error when `fs-ext` itself is
// MISSING. A real `flockSync` call failure — `ENOTSUP`/`ENOSYS` (advisory
// locks unsupported, e.g. some network filesystems), a malformed/partial
// native export, etc. — must NOT be rethrown raw: it must be wrapped in a
// `ReviewLeaseError` naming the lock path, the original code, and the
// local-filesystem/fs-ext guidance. The busy path (`EAGAIN`/`EWOULDBLOCK`)
// must remain completely unaffected.
// ---------------------------------------------------------------------------

describe("acquireReviewLease — non-busy flock failures are wrapped, not raw", () => {
  afterEach(() => {
    // Always restore the real native flockSync so later tests (in this file,
    // and any other lease acquisitions) are unaffected by the injected fake.
    _setFlockSyncForTest(undefined);
  });

  it("wraps a real ENOTSUP flockSync failure in an actionable ReviewLeaseError, not busy", () => {
    const notsup: FlockSyncFn = () => {
      const err = new Error(
        "flock: operation not supported on socket"
      ) as NodeJS.ErrnoException;
      err.code = "ENOTSUP";
      throw err;
    };
    _setFlockSyncForTest(notsup);

    let thrown: unknown;
    try {
      acquireReviewLease(leaseOpts({ runId: "notsup-run" }));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ReviewLeaseError);
    const err = thrown as ReviewLeaseError;
    expect(err.code).toBe("ENOTSUP");
    expect(err.message).toContain(lockFile());
    expect(err.message).toContain("ENOTSUP");
    expect(err.message.toLowerCase()).toContain("local filesystem");
    expect(err.message).toContain("fs-ext");
    expect((err.cause as NodeJS.ErrnoException)?.code).toBe("ENOTSUP");
  });

  it("throws the actionable error (not the raw error) when the resolved flockSync export is not callable", () => {
    _setFlockSyncForTest(
      123 as unknown as FlockSyncFn // simulates a malformed/partial fs-ext export
    );

    let thrown: unknown;
    try {
      acquireReviewLease(leaseOpts({ runId: "not-callable-run" }));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ReviewLeaseError);
    const err = thrown as ReviewLeaseError;
    expect(err.message).toContain(lockFile());
    expect(err.message).toContain("fs-ext");
  });

  it("the genuine busy path (EAGAIN) still returns { acquired: false, reason: 'busy' }, unaffected", () => {
    const eagain: FlockSyncFn = (fd, op) => {
      if (op === "exnb") {
        const err = new Error("resource busy") as NodeJS.ErrnoException;
        err.code = "EAGAIN";
        throw err;
      }
    };
    _setFlockSyncForTest(eagain);

    const res = acquireReviewLease(leaseOpts({ runId: "busy-run" }));
    expect(res.acquired).toBe(false);
    if (!res.acquired) expect(res.reason).toBe("busy");
  });

  it("a normal acquire still works once the real flockSync is restored", () => {
    _setFlockSyncForTest(undefined);
    const res = acquire({ runId: "still-works" });
    expect(res.acquired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy, optional native `fs-ext` load (P32 — opt-in / inert-by-default)
//
// `fs-ext` is a NATIVE, OPTIONAL dependency. It must be loaded LAZILY — only
// when an actual review acquires a lease — so that merely importing the barrel
// or running a non-review path (`--help`, `--print-config`, any other bin)
// never touches the native addon. A missing/unbuildable addon must fail with an
// ACTIONABLE error (naming the module + how to install), not a raw MODULE_NOT
// _FOUND. We inject a fake `require` so we never have to uninstall fs-ext.
// ---------------------------------------------------------------------------

describe("lazy fs-ext load (_resolveFlockSync)", () => {
  it("throws an ACTIONABLE error naming fs-ext when the native load fails", () => {
    const boom = () => {
      throw new Error("Cannot find module 'fs-ext'");
    };
    let thrown: Error | undefined;
    try {
      _resolveFlockSync(boom);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = thrown?.message ?? "";
    expect(msg).toContain("fs-ext");
    expect(msg).toContain("otto-review");
    expect(msg).toContain("build toolchain");
    // The underlying failure is preserved for diagnosis.
    expect(msg).toContain("Cannot find module 'fs-ext'");
  });

  it("resolves the real native flockSync when fs-ext is present (default require)", () => {
    // No injected require → uses the module's own createRequire. fs-ext is an
    // installed optionalDependency in the workspace, so this resolves a real fn.
    const fn = _resolveFlockSync();
    expect(typeof fn).toBe("function");
  });

  it("returns the injected module's flockSync unchanged on success", () => {
    const fake = (() => {}) as unknown;
    const fn = _resolveFlockSync(() => ({ flockSync: fake }));
    expect(fn).toBe(fake);
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
