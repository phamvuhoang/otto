/**
 * Per-composite-identity local review state and a kernel-serialized OS lock
 * lease (P32 — Slice 2: watch / idempotency).
 *
 * A watch daemon must review each composite identity
 * `(repository, pullRequest, headSha, inputFingerprint)` EXACTLY once and be
 * able to recover after a crash. This module provides the two on-disk
 * primitives that make that safe on a single workspace:
 *
 *  - {@link writeReviewState}/{@link readReviewState}: one durable JSON record
 *    per composite identity under gitignored
 *    `.otto/review-state/github/<owner>/<repo>/<pr>/<head-sha>/<fingerprint>.json`.
 *    A new head SHA or a changed input fingerprint is a SEPARATE file, so
 *    force-push and changed review intent never overwrite prior history.
 *
 *  - {@link acquireReviewLease}: a SYNCHRONOUS lease backed by a real OS advisory
 *    lock ({@link https://man7.org/linux/man-pages/man2/flock.2.html flock}) at
 *    the composite path (`<state-path>.lock`). Acquisition opens a lock file,
 *    keeps its fd open for the run's lifetime, and takes an EXCLUSIVE
 *    NON-BLOCKING flock. Because the lock lives in the kernel and is keyed to the
 *    open file description, two daemons on the SAME workspace CANNOT both take
 *    it: the loser gets `EAGAIN`/`EWOULDBLOCK` → `{ acquired: false, reason:
 *    "busy" }`. There is no read-decide-takeover window, so two racers can never
 *    both acquire the same identity — the race the old PID-liveness claim scheme
 *    could not close.
 *
 *    Crash recovery is AUTOMATIC. The kernel releases a flock the instant the
 *    holding fd closes or the holding process dies, so a crashed daemon's lock is
 *    freed with no PID probe, no tombstone, no staleness clock, and no read of
 *    the lock file's content (the FLOCK, not the file body, is the authority). A
 *    restart's exclusive flock simply succeeds. The lock file may carry
 *    `{runId,pid,acquiredAt}` as human evidence only.
 *
 *    The lease exposes {@link ReviewLease.release} (flock `LOCK_UN` + close the
 *    fd; idempotent — the lock FILE is left persistent so exclusion survives, as
 *    unlinking a flock'd file would decouple future acquirers onto a fresh inode)
 *    and {@link ReviewLease.ownsClaim} (while we still hold the fd's flock we are
 *    the sole owner, kernel-guaranteed — it returns `!released`, used by the
 *    pipeline as a defense-in-depth fence before every remote write). flock needs
 *    no heartbeat.
 *
 * The lease API is synchronous. This module performs NO GitHub, model, or
 * pipeline I/O.
 */

import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parseReviewInputFingerprint } from "./pr-review-input.js";

// ---------------------------------------------------------------------------
// Lazy, optional native `fs-ext` load (P32 — opt-in / inert-by-default)
// ---------------------------------------------------------------------------

/**
 * `flockSync` operation strings. `exnb` is exclusive non-blocking (throws
 * `EAGAIN`/`EWOULDBLOCK` when another open file description already holds the
 * lock); `un` releases.
 */
type FlockOp = "sh" | "ex" | "shnb" | "exnb" | "un";
export type FlockSyncFn = (fd: number, op: FlockOp) => void;

const requireCjs = createRequire(import.meta.url);

/** A CJS `require`-like resolver — the seam that lets tests inject a failure. */
type RequireLike = (id: string) => unknown;

/**
 * Resolve the native `flockSync` from `fs-ext` using `req`, or throw an
 * ACTIONABLE error naming the optional module and how to install it. Exported
 * under an underscore for the unit test only (inject a `require` that throws to
 * assert the guidance; inject the real one to assert a normal resolve).
 */
export function _resolveFlockSync(req: RequireLike = requireCjs): FlockSyncFn {
  try {
    return (req("fs-ext") as { flockSync: FlockSyncFn }).flockSync;
  } catch (err) {
    throw new Error(
      "otto-review requires the optional native module 'fs-ext' for its file lock. " +
        "Install it (a C/C++ build toolchain is required to build the native addon): " +
        "`pnpm add fs-ext` in the workspace, or ensure prebuilt binaries are available. " +
        "Original error: " +
        (err && (err as Error).message ? (err as Error).message : String(err))
    );
  }
}

/**
 * Cached native `flockSync`. `undefined` until first lease acquisition, after
 * which it is the resolved function (fs-ext present) — or {@link getFlockSync}
 * throws an actionable error on every call while the native module is absent.
 *
 * `fs-ext` is an OPTIONAL native dependency loaded LAZILY here so that merely
 * importing the core barrel — or running any non-review command / `--help` /
 * `--print-config` — never touches the native addon. The load happens ONLY when
 * an actual `otto-review` review acquires a lease (see {@link acquireReviewLease}).
 */
let flockSyncImpl: FlockSyncFn | undefined;

/** The `require`-like loader {@link getFlockSync} uses; overridable for tests. */
let flockLoader: RequireLike = requireCjs;

function getFlockSync(): FlockSyncFn {
  if (flockSyncImpl === undefined) {
    flockSyncImpl = _resolveFlockSync(flockLoader);
  }
  return flockSyncImpl;
}

/**
 * Test-only seam: override (or, passed `undefined`, reset) the CACHED native
 * `flockSync` consulted by {@link getFlockSync}. This lets tests exercise a
 * genuine `flockSync` CALL failure (e.g. `ENOTSUP`) or a malformed/partial
 * `fs-ext` export (a non-function value) without needing an actually broken
 * native install — {@link _resolveFlockSync} alone can't simulate either,
 * since it only covers the `require("fs-ext")` step. Not for production use.
 */
export function _setFlockSyncForTest(fn: FlockSyncFn | undefined): void {
  flockSyncImpl = fn;
}

/**
 * Test-only seam: force the LAZY module resolution done by {@link getFlockSync}
 * to run through `req` (e.g. one that throws to simulate a missing/unbuildable
 * `fs-ext`), or reset to the real `require` when passed `undefined`. Also
 * clears the resolution cache so the next acquire re-resolves. Not for
 * production use.
 */
export function _setFlockLoaderForTest(req: RequireLike | undefined): void {
  flockLoader = req ?? requireCjs;
  flockSyncImpl = undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-output publication state, filled in as each sink succeeds. */
export type PullRequestReviewOutputState = {
  text?: { status: "succeeded" };
  markdown?: { status: "succeeded"; path: string };
  comment?: { status: "succeeded"; commentId: number };
  githubReview?: { status: "succeeded"; reviewId: number };
};

/** The durable per-composite-identity review record. */
export type PullRequestReviewState = {
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  status:
    | "running"
    | "analysis-failed"
    | "publish-failed"
    | "succeeded"
    | "superseded"
    | "cancelled";
  runId: string;
  analysisArtifact?: string;
  outputs: PullRequestReviewOutputState;
  attempts: number;
  retryable?: boolean;
  nextRetryAt?: string;
  error?: string;
  updatedAt: string;
};

/**
 * A held OS-flock lease over one composite identity.
 *
 * While the lease's fd holds the exclusive flock we are the SOLE owner
 * (kernel-guaranteed) — ownership cannot change under a live holder.
 *
 *  - `release` drops the flock (`LOCK_UN`) and closes the fd. It is idempotent —
 *    safe to call repeatedly (e.g. in a `finally`). The lock FILE is left
 *    persistent (a stable inode keeps all acquirers contending on the same lock;
 *    unlinking it would decouple future acquirers onto a fresh inode).
 *  - `ownsClaim` reports whether we still hold the lock (`!released`). The
 *    pipeline calls it immediately before every remote write as a
 *    defense-in-depth fence.
 */
export type ReviewLease = {
  release: () => void;
  ownsClaim: () => boolean;
};

export type ReviewLeaseResult =
  | { acquired: true; lease: ReviewLease }
  | { acquired: false; reason: "busy" };

// ---------------------------------------------------------------------------
// Identity validation (fail-closed before any disk I/O)
// ---------------------------------------------------------------------------

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{40,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Split and validate `owner/name`, returning the lower-cased path segments. */
function splitAndValidateRepo(repository: string): {
  owner: string;
  name: string;
} {
  const slash = repository.indexOf("/");
  if (
    slash <= 0 ||
    slash !== repository.lastIndexOf("/") ||
    slash === repository.length - 1
  ) {
    throw new Error(
      `repository must be "owner/name", got: ${JSON.stringify(repository)}`
    );
  }
  const owner = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  for (const seg of [owner, name]) {
    if (seg === "." || seg === ".." || !SEGMENT_RE.test(seg)) {
      throw new Error(
        `repository "owner/name" segment is invalid: ${JSON.stringify(repository)}`
      );
    }
  }
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
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

function assertRunId(runId: string): void {
  if (runId === "." || runId === ".." || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The exact on-disk path of one composite identity's state record:
 * `.otto/review-state/github/<owner>/<repo>/<pr>/<head-sha>/<fingerprint>.json`
 * with a lower-cased owner/repo for a stable path. Throws on any invalid
 * identity component before returning (so no bad path is ever constructed).
 */
export function reviewStatePath(
  workspaceDir: string,
  repository: string,
  pr: number,
  headSha: string,
  inputFingerprint: string
): string {
  const { owner, name } = splitAndValidateRepo(repository);
  assertPr(pr);
  assertSha(headSha);
  parseReviewInputFingerprint(inputFingerprint);
  return join(
    workspaceDir,
    ".otto",
    "review-state",
    "github",
    owner,
    name,
    String(pr),
    headSha,
    `${inputFingerprint}.json`
  );
}

/** The OS-flock lock-file path for the same composite identity. */
function reviewLockPath(
  workspaceDir: string,
  repository: string,
  pr: number,
  headSha: string,
  inputFingerprint: string
): string {
  const statePath = reviewStatePath(
    workspaceDir,
    repository,
    pr,
    headSha,
    inputFingerprint
  );
  return statePath.replace(/\.json$/, ".lock");
}

// ---------------------------------------------------------------------------
// Atomic write helpers
// ---------------------------------------------------------------------------

/** Same-directory temp file + fsync + rename: never a partial `path`. */
function atomicWriteFile(path: string, body: string, suffix: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${suffix}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function statFile(path: string): Stats | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st : null; // reject symlink/dir/fifo as absent
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/**
 * Persist a review state atomically at its composite path. Validates every
 * identity component (repo/PR/SHA/fingerprint/runId) BEFORE touching disk, so a
 * malformed record can never create a bogus path or a half-written file.
 */
export function writeReviewState(
  workspaceDir: string,
  state: PullRequestReviewState
): void {
  const path = reviewStatePath(
    workspaceDir,
    state.repository,
    state.pullRequest,
    state.headSha,
    state.inputFingerprint
  );
  assertRunId(state.runId);
  atomicWriteFile(
    path,
    JSON.stringify(state, null, 2),
    `${process.pid}-${state.runId}`
  );
}

const VALID_STATUS = new Set<PullRequestReviewState["status"]>([
  "running",
  "analysis-failed",
  "publish-failed",
  "succeeded",
  "superseded",
  "cancelled",
]);

/**
 * Read + identity-validate the state at a composite path. Returns `null` for an
 * absent/malformed record, a record whose stored identity disagrees with its
 * path, OR an `analysisArtifact` that is not EXACTLY
 * `.otto/runs/<runId>/analysis.json` — a caller never mistakes a mismatched or
 * tampered record for this identity's state.
 */
export function readReviewState(
  workspaceDir: string,
  repository: string,
  pr: number,
  headSha: string,
  inputFingerprint: string
): PullRequestReviewState | null {
  let path: string;
  try {
    path = reviewStatePath(
      workspaceDir,
      repository,
      pr,
      headSha,
      inputFingerprint
    );
  } catch {
    return null;
  }
  if (!statFile(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as PullRequestReviewState;

  // Identity must match the path exactly.
  if (
    s.repository !== repository ||
    s.pullRequest !== pr ||
    s.headSha !== headSha ||
    s.inputFingerprint !== inputFingerprint
  ) {
    return null;
  }
  if (!VALID_STATUS.has(s.status)) return null;
  if (
    typeof s.runId !== "string" ||
    s.runId === "" ||
    s.runId === "." ||
    s.runId === ".." ||
    !RUN_ID_RE.test(s.runId)
  )
    return null;
  if (typeof s.attempts !== "number" || typeof s.updatedAt !== "string")
    return null;
  if (typeof s.outputs !== "object" || s.outputs === null) return null;

  // Fingerprint must itself be a canonical 64-lower-hex digest.
  try {
    parseReviewInputFingerprint(s.inputFingerprint);
  } catch {
    return null;
  }

  // An analysisArtifact, when present, must be the canonical run path only.
  if (s.analysisArtifact !== undefined) {
    if (s.analysisArtifact !== `.otto/runs/${s.runId}/analysis.json`)
      return null;
  }

  return s;
}

// ---------------------------------------------------------------------------
// OS-flock lease
// ---------------------------------------------------------------------------

/** flock operations are keyed to the open file description behind an fd. */
type FlockErrno = NodeJS.ErrnoException;

/** A busy flock: another live open file description already holds the lock. */
function isBusyFlockError(err: unknown): boolean {
  const code = (err as FlockErrno).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

/**
 * A non-busy failure of the P32 file lock: a real `flockSync` CALL error
 * (e.g. `ENOTSUP`/`ENOSYS` — advisory locks unsupported by the underlying
 * filesystem — or `EBADF`), or a malformed/non-callable `fs-ext` export. This
 * is distinct from "busy" (`EAGAIN`/`EWOULDBLOCK`, a live competing holder):
 * it means the lock mechanism itself could not run, which {@link
 * isBusyFlockError} must never mask as "busy".
 */
export class ReviewLeaseError extends Error {
  /** The original errno code (e.g. `"ENOTSUP"`), or `"EFLOCK"` if unknown. */
  readonly code: string;

  constructor(message: string, options: { code: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ReviewLeaseError";
    this.code = options.code;
  }
}

/**
 * Wrap a non-busy flock failure at `lockPath` into an ACTIONABLE {@link
 * ReviewLeaseError} — never rethrow the raw error. Includes the lock path,
 * the original errno/code and message (also as `cause`), and guidance that
 * the P32 file lock requires a LOCAL filesystem (advisory `flock` is
 * unreliable or unsupported on some network filesystems, e.g. NFS) and a
 * correctly built/installed native `fs-ext` addon.
 */
function wrapFlockError(err: unknown, lockPath: string): ReviewLeaseError {
  const rawCode = (err as FlockErrno | undefined)?.code;
  const code = typeof rawCode === "string" ? rawCode : "EFLOCK";
  const detail =
    err instanceof Error ? err.message : String((err as unknown) ?? "");
  return new ReviewLeaseError(
    `otto-review could not acquire its OS file lock at "${lockPath}" ` +
      `(${code}): ${detail}. The P32 review lease requires flock() on a ` +
      "LOCAL filesystem — advisory flock is unreliable or unsupported on " +
      "some network filesystems (e.g. NFS) — and a correctly built/installed " +
      "native 'fs-ext' addon. Move the workspace to local disk, or reinstall " +
      "fs-ext (`pnpm add fs-ext`) and retry.",
    { code, cause: err }
  );
}

/**
 * Build the lease handle for a lock file whose exclusive flock we hold on `fd`.
 * While the fd holds the flock we are the sole owner (kernel-guaranteed), so
 * `ownsClaim` is simply `!released`. `release` is idempotent.
 */
function makeLease(fd: number, lockPath: string): ReviewLease {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      // Drop the kernel lock and close the fd. The lock FILE is left PERSISTENT
      // on purpose: unlinking a flock'd file decouples future acquirers onto a
      // fresh inode (path→new inode via O_CREAT) whose flock is independent of the
      // inode a concurrent acquirer may already hold → double-acquire. Keeping a
      // stable inode means every acquirer opens the same path → same inode →
      // contends on the SAME kernel lock. On crash the kernel frees the lock and
      // the file survives for the next acquire to re-lock.
      try {
        getFlockSync()(fd, "un");
      } catch {
        /* best-effort: closing the fd releases the lock regardless */
      }
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    },
    ownsClaim: () => !released,
  };
}

/**
 * Acquire the OS-flock lease for a composite identity.
 *
 * Opens the lock file (`<state-path>.lock`), keeps its fd open for the run's
 * lifetime, and takes an EXCLUSIVE NON-BLOCKING flock. Returns:
 *
 *  - `{ acquired: true, lease }` — the lock is now ours. `lease.ownsClaim()` is
 *    the pipeline's per-write fence and `lease.release()` drops the lock + closes
 *    the fd (idempotent). The lock file is left persistent — see {@link makeLease}.
 *  - `{ acquired: false, reason: "busy" }` — a LIVE process already holds the
 *    lock (`EAGAIN`/`EWOULDBLOCK`). Kernel-serialized: two racers cannot both
 *    acquire. The caller treats busy as `skipped` with no analysis.
 *
 * There is NO stale-claim logic: the kernel releases a flock the instant the
 * holding fd closes or the process dies, so a crashed daemon's lock is
 * auto-released and a restart's exclusive flock simply succeeds. The lock file's
 * content (optional `{runId,pid,acquiredAt}` evidence) is NEVER read to make a
 * decision — the flock is the authority.
 */
export function acquireReviewLease(opts: {
  workspaceDir: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  runId: string;
}): ReviewLeaseResult {
  assertRunId(opts.runId);
  const lockPath = reviewLockPath(
    opts.workspaceDir,
    opts.repository,
    opts.pullRequest,
    opts.headSha,
    opts.inputFingerprint
  );

  mkdirSync(dirname(lockPath), { recursive: true });
  // Open O_APPEND|O_CREAT (no truncate): opening never disturbs a lock another
  // live process holds; the flock — not this open — arbitrates ownership.
  const fd = openSync(lockPath, "a");

  // Resolve the native flock AND call it inside one try so that EVERY failure
  // out of this block — a missing/unbuildable `fs-ext` (getFlockSync throws), a
  // malformed/non-callable export, or a real flockSync CALL error (ENOTSUP/
  // EBADF/…) — closes the fd we opened just above before rethrowing. Doing the
  // resolution above this try would leak that fd on a resolution failure (and,
  // since a failed resolution is not cached, leak one fd per poll in watch mode).
  try {
    const flock = getFlockSync();
    if (typeof flock !== "function") {
      // A malformed/partial `fs-ext` export — effectively a broken native module.
      throw wrapFlockError(
        new Error(
          `'fs-ext' resolved a flockSync export that is not callable (got ${typeof flock})`
        ),
        lockPath
      );
    }
    flock(fd, "exnb");
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
    if (isBusyFlockError(err)) return { acquired: false, reason: "busy" };
    // Already-actionable errors (the non-callable guard above) pass through
    // unchanged; everything else — including a module-resolution failure — is
    // wrapped so the caller always gets the lock path + remediation guidance.
    if (err instanceof ReviewLeaseError) throw err;
    throw wrapFlockError(err, lockPath);
  }

  // The lock is ours. Record human-readable evidence best-effort (never gates
  // ownership). Truncate first so stale evidence from a prior crash is replaced.
  try {
    ftruncateSync(fd, 0);
    writeSync(
      fd,
      JSON.stringify({
        runId: opts.runId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      0
    );
    fsyncSync(fd);
  } catch {
    /* best-effort: evidence only */
  }

  return { acquired: true, lease: makeLease(fd, lockPath) };
}

// ---------------------------------------------------------------------------
// Runnability
// ---------------------------------------------------------------------------

/**
 * Whether a composite identity is eligible for a (re)review from its state
 * alone — the flock lease layer is the concurrency gate on top of this.
 *
 *  - no state → runnable (never reviewed);
 *  - `succeeded` → not runnable (done);
 *  - `analysis-failed`/`publish-failed` → runnable only if `retryable` and
 *    `now >= nextRetryAt`; a permanent (non-retryable) failure is terminal;
 *  - `running` → runnable (a possibly-crashed run; {@link acquireReviewLease}
 *    decides whether it is actually free or still leased);
 *  - `superseded`/`cancelled` → runnable (the same composite identity may be
 *    reviewed again once eligible).
 */
export function isStateRunnable(
  state: PullRequestReviewState | null,
  now?: Date
): boolean {
  if (state === null) return true;
  const at = now ?? new Date();
  switch (state.status) {
    case "succeeded":
      return false;
    case "analysis-failed":
    case "publish-failed":
      if (state.retryable !== true) return false;
      if (state.nextRetryAt === undefined) return true;
      return at.getTime() >= Date.parse(state.nextRetryAt);
    case "running":
    case "superseded":
    case "cancelled":
      return true;
  }
}
