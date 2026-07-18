/**
 * Per-composite-identity local review state, atomic claims, and lease recovery
 * (P32 Task 11 — start of Slice 2: watch / idempotency).
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
 *  - {@link acquireReviewLease}: an OWNERSHIP-ATOMIC advisory lease at the same
 *    composite path, backed by `proper-lockfile` (an mkdir-based advisory lock).
 *    Acquisition is a real atomic `mkdir` of `<claim-path>.lock`, never a
 *    read-then-write race, so two daemons on the SAME workspace cannot both
 *    review one identity. The lock is auto-refreshed (mtime touch) roughly every
 *    {@link REVIEW_LEASE_HEARTBEAT_MS} and considered STALE after
 *    {@link REVIEW_LEASE_STALE_MS} without a refresh; a stale lock is recovered
 *    by another acquirer with no read-then-write window. When a slow holder's
 *    lock is stolen by a stale-recovery, the lease's
 *    {@link ReviewLease.compromised} `AbortSignal` fires — but only on the
 *    holder's NEXT auto-refresh tick (`proper-lockfile`'s update timer issues
 *    an `fs.stat` roughly every {@link REVIEW_LEASE_HEARTBEAT_MS} to notice
 *    the steal), not synchronously with the steal itself. That leaves a
 *    residual sub-second window in which the old holder hasn't yet noticed.
 *    This window is NOT closed by the lock; it is backstopped by the
 *    pipeline: every remote write re-queries and reconciles state immediately
 *    before writing, and publication is marker-idempotent (a marker-owned
 *    comment upsert, plus `author === viewer` reconciliation before a formal
 *    GitHub review is filed) — so even a stale holder that races past its own
 *    abort cannot produce a duplicate remote artifact.
 *
 * The lease API is async because `proper-lockfile` is promise-based. Staleness
 * timing is configurable per-call (used to keep tests fast and deterministic
 * without real long sleeps). This module performs NO GitHub, model, or pipeline
 * I/O.
 */

import {
  closeSync,
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
import lockfile from "proper-lockfile";
import { parseReviewInputFingerprint } from "./pr-review-input.js";

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
 * A held, ownership-atomic advisory lease over one composite identity.
 *
 * `compromised` fires exactly once if the underlying lock is stolen out from
 * under this holder (a stale-recovery by another process, or the lock dir
 * vanishing). The caller MUST treat that as "another process took over": abort
 * the in-flight run and publish nothing rather than double-review. `release`
 * frees the lock and is safe to call multiple times (e.g. in a `finally`).
 */
export type ReviewLease = {
  release: () => Promise<void>;
  readonly compromised: AbortSignal;
};

export type ReviewLeaseResult =
  | { acquired: true; lease: ReviewLease }
  | { acquired: false; reason: "busy" };

/** Refresh the lease at least this often while a review is in flight. */
export const REVIEW_LEASE_HEARTBEAT_MS = 60_000;
/** A lease with no refresh for this long is stale and may be recovered. */
export const REVIEW_LEASE_STALE_MS = 15 * 60_000;

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

/** The advisory-lease path for the same composite identity. */
function reviewClaimPath(
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
  return statePath.replace(/\.json$/, ".claim");
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
// Atomic claim / lease
// ---------------------------------------------------------------------------

/**
 * Acquire the ownership-atomic advisory lease for a composite identity.
 *
 * Backed by `proper-lockfile`: the lock resource is `<claim-path>.lock` (a
 * directory whose atomic `mkdir` IS the acquire; there is no read-then-write
 * window). Returns:
 *
 *  - `{ acquired: true, lease }` — we hold the lock. `proper-lockfile`
 *    auto-refreshes the lock's mtime (~every {@link REVIEW_LEASE_HEARTBEAT_MS}),
 *    replacing any manual heartbeat. `lease.compromised` is an `AbortSignal`
 *    that fires if the lock is stolen from us (a stale-recovery by another
 *    process, or the lock dir vanishing); the caller MUST abort on it.
 *  - `{ acquired: false, reason: "busy" }` — a LIVE lock is already held
 *    (ELOCKED). The caller treats this as `skipped` with no analysis.
 *
 * A STALE lock (no refresh for {@link REVIEW_LEASE_STALE_MS}, e.g. a crashed
 * holder) is transparently recovered by `proper-lockfile` and acquired here.
 *
 * `staleMs`/`updateMs` override the staleness/refresh windows (used by tests to
 * stay fast and deterministic without real long sleeps). `proper-lockfile`
 * clamps `stale` to a 2s minimum and `update` to `[1s, stale/2]`.
 */
export async function acquireReviewLease(opts: {
  workspaceDir: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  runId: string;
  staleMs?: number;
  updateMs?: number;
}): Promise<ReviewLeaseResult> {
  assertRunId(opts.runId);
  const claimPath = reviewClaimPath(
    opts.workspaceDir,
    opts.repository,
    opts.pullRequest,
    opts.headSha,
    opts.inputFingerprint
  );
  // proper-lockfile mkdirs `<claimPath>.lock` but does NOT create parents, and
  // the claim path itself may not pre-exist — ensure the composite directory is
  // present so the atomic mkdir acquire can succeed.
  mkdirSync(dirname(claimPath), { recursive: true });

  const controller = new AbortController();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(claimPath, {
      realpath: false,
      stale: opts.staleMs ?? REVIEW_LEASE_STALE_MS,
      update: opts.updateMs ?? REVIEW_LEASE_HEARTBEAT_MS,
      onCompromised: (err: Error) => {
        // The lock was stolen (stale-recovered) or removed under us. Signal the
        // holder to STOP — it must not clobber the recoverer's fresh lock.
        if (!controller.signal.aborted) controller.abort(err);
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
      return { acquired: false, reason: "busy" };
    }
    throw err;
  }

  let released = false;
  const acquiredRelease = release;
  return {
    acquired: true,
    lease: {
      compromised: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await acquiredRelease();
        } catch {
          // Already released, or compromised (another process recovered a stale
          // lock and now owns it). Nothing to free — never touch its lock.
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runnability
// ---------------------------------------------------------------------------

/**
 * Whether a composite identity is eligible for a (re)review from its state
 * alone — the claim layer is the concurrency gate on top of this.
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
