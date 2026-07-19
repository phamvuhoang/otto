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
 *  - {@link acquireReviewLease}: a SYNCHRONOUS, ownership-fenced PID-liveness
 *    lease at the same composite path (`<claim-path>.claim`). Acquisition is a
 *    real atomic exclusive create-with-content (a fully-written temp file
 *    `linkSync`'d into place — EEXIST if already held), never a read-then-write
 *    race nor an empty-then-fill window, so two daemons on the SAME workspace
 *    cannot both review one identity.
 *    The claim records the holder's `pid`; a LIVE holder is NEVER dispossessed
 *    ({@link isPidAlive}). Only a claim whose recorded pid is DEAD (or an
 *    unparseable claim) is stale and takeable — recovery is arbitrated by
 *    atomically renaming the stale claim to a UNIQUE tombstone (only the racer
 *    whose rename wins may then exclusively create the fresh claim), again with
 *    no read-then-write window.
 *
 *    Because a live holder is never dispossessed there is no "compromise": the
 *    lease exposes {@link ReviewLease.release} (ownership-fenced — it deletes the
 *    claim ONLY while it is still ours, so an old holder that was stale-recovered
 *    can never delete the recoverer's fresh claim) and {@link ReviewLease.ownsClaim}
 *    (a synchronous re-read of the claim used by the pipeline to revalidate
 *    ownership immediately before every remote write). A long-running review's
 *    live pid keeps the lease safe with no mtime refresh, so there is no periodic
 *    heartbeat.
 *
 * The lease API is synchronous. `isPidAlive` is injectable so tests are
 * deterministic and hermetic (no real subprocess spawning). This module performs
 * NO GitHub, model, or pipeline I/O.
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
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

/** The on-disk PID-liveness claim record for one composite identity. */
export type PullRequestReviewClaim = {
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  runId: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
};

/**
 * A held, ownership-fenced PID-liveness lease over one composite identity.
 *
 * A live holder is never dispossessed, so there is no "compromise" to signal.
 *
 *  - `release` deletes the on-disk claim ONLY while it is still ours (ownership
 *    fence) and is idempotent — safe to call repeatedly (e.g. in a `finally`),
 *    and it NEVER deletes a claim another process now owns.
 *  - `ownsClaim` synchronously re-reads the claim and reports whether it is still
 *    ours. The pipeline calls it immediately before every remote write as a
 *    defense-in-depth ownership fence.
 */
export type ReviewLease = {
  release: () => void;
  ownsClaim: () => boolean;
};

export type ReviewLeaseResult =
  | { acquired: true; lease: ReviewLease }
  | { acquired: false; reason: "busy" };

/**
 * VESTIGIAL cadence hints. The lease is pure PID-liveness (no mtime refresh, no
 * heartbeat), so these constants NO LONGER gate acquisition, staleness, or
 * anything else in this module. They are retained ONLY because they are
 * re-exported via `index.ts` and asserted by a test; nothing reads them to make
 * a decision. Do not reintroduce time-based staleness on top of them.
 */
export const REVIEW_LEASE_HEARTBEAT_MS = 60_000;
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

/** Monotonic per-process suffix so concurrent creates never share a temp name. */
let exclusiveCreateSeq = 0;

/**
 * Atomic exclusive-create-WITH-content. `path` appears in place ALREADY holding
 * its full body, so a concurrent reader sees either NO file or a COMPLETE one —
 * never the empty/partial file that `openSync(path,"wx")`+`writeSync` briefly
 * exposed between the 0-byte create and the write.
 *
 * The content is first written+fsync'd+closed into a unique same-directory temp
 * file, then `linkSync(temp, path)` atomically publishes it: the link SUCCEEDS
 * only if `path` did not exist and throws `EEXIST` otherwise — the exact
 * exclusive-create GATE the old `wx` open provided. Returns `true` on create,
 * `false` on EEXIST (path already held). The temp file is always unlinked.
 */
function exclusiveWriteFile(path: string, body: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.create-${process.pid}-${++exclusiveCreateSeq}`;
  // Write the FULL content durably to the temp file first.
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // Atomic exclusive publish: EEXIST if `path` is already held.
    linkSync(tmpPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    // The linked content survives at `path`; drop the temp name.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }
  return true;
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

/** Read + shape-validate the claim at a path. Unparseable → `null` (stale). */
function parseClaim(path: string): PullRequestReviewClaim | null {
  if (!statFile(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as PullRequestReviewClaim;
  // A claim's validity hinges ONLY on its identity/liveness fields. `heartbeatAt`
  // is retained as evidence but the lease no longer heartbeats, so its presence
  // must NOT gate validity (a missing/legacy heartbeat is not "stale").
  if (
    typeof c.runId !== "string" ||
    c.runId === "" ||
    typeof c.pid !== "number" ||
    !Number.isFinite(c.pid) ||
    typeof c.acquiredAt !== "string"
  ) {
    return null;
  }
  return c;
}

/**
 * Real PID-liveness probe. `process.kill(pid, 0)` sends no signal but performs
 * the existence/permission check: success → the process exists and is
 * signalable; `EPERM` → it exists but is owned by another user (still ALIVE);
 * `ESRCH` (or anything else) → it does not exist (DEAD).
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Build the ownership-fenced lease handle for a claim we currently hold. */
function makeLease(claimPath: string, runId: string): ReviewLease {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      // Ownership fence: delete ONLY while the claim is still ours. An old holder
      // that a recoverer dispossessed must never delete the recoverer's claim.
      const existing = parseClaim(claimPath);
      if (!existing || existing.runId !== runId) return;
      try {
        unlinkSync(claimPath);
      } catch {
        /* best-effort: already gone or replaced */
      }
    },
    ownsClaim: () => {
      const existing = parseClaim(claimPath);
      return existing !== null && existing.runId === runId;
    },
  };
}

/**
 * Acquire the ownership-fenced PID-liveness lease for a composite identity.
 *
 * The claim resource is `<claim-path>.claim`. Acquisition is an atomic exclusive
 * create-with-content (a fully-written temp file `linkSync`'d into place); there
 * is no read-then-write window and no empty-file window. Returns:
 *
 *  - `{ acquired: true, lease }` — the claim is now ours. `lease.release()` is
 *    ownership-fenced + idempotent and `lease.ownsClaim()` re-reads ownership for
 *    the pipeline's per-write fence.
 *  - `{ acquired: false, reason: "busy" }` — a LIVE holder already owns the
 *    claim. A live holder is NEVER dispossessed. The caller treats busy as
 *    `skipped` with no analysis.
 *
 * A STALE claim — one whose recorded `pid` is DEAD, or one that is unparseable —
 * is taken over via a UNIQUE tombstone rename: only the racer whose `renameSync`
 * wins may then exclusively create the fresh claim (a lost rename, a vanished
 * claim, or a third party creating in the gap → busy). `isPidAlive` is injectable
 * for deterministic tests.
 */
export function acquireReviewLease(opts: {
  workspaceDir: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  runId: string;
  isPidAlive?: (pid: number) => boolean;
}): ReviewLeaseResult {
  assertRunId(opts.runId);
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const claimPath = reviewClaimPath(
    opts.workspaceDir,
    opts.repository,
    opts.pullRequest,
    opts.headSha,
    opts.inputFingerprint
  );

  const now = new Date().toISOString();
  const claim: PullRequestReviewClaim = {
    repository: opts.repository,
    pullRequest: opts.pullRequest,
    headSha: opts.headSha,
    inputFingerprint: opts.inputFingerprint,
    runId: opts.runId,
    pid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
  };
  const body = JSON.stringify(claim, null, 2);

  // Fast path: exclusive create wins outright.
  if (exclusiveWriteFile(claimPath, body)) {
    return { acquired: true, lease: makeLease(claimPath, opts.runId) };
  }

  // Someone holds it. Defense-in-depth: a claim file that EXISTS but is
  // byte-EMPTY is a create still in progress (or a stray truncated file) — a
  // live create must never be stolen, so treat empty as BUSY, not stale. (After
  // the link-based create above an empty claim should never be observable; this
  // keeps the reader robust regardless.)
  const existingStat = statFile(claimPath);
  if (existingStat !== null && existingStat.size === 0) {
    return { acquired: false, reason: "busy" };
  }

  // It is STALE and takeable ONLY IF unparseable or its pid is
  // dead. A live holder is never dispossessed.
  const existing = parseClaim(claimPath);
  if (existing !== null && isPidAlive(existing.pid)) {
    return { acquired: false, reason: "busy" };
  }

  // Stale claim: arbitrate recovery via a unique tombstone rename.
  const tombstone = `${claimPath}.stale-${opts.runId}`;
  try {
    renameSync(claimPath, tombstone);
  } catch {
    // Lost the rename (another recoverer already moved it) OR it vanished — a
    // third party is arbitrating. Respect it: busy.
    return { acquired: false, reason: "busy" };
  }
  try {
    if (exclusiveWriteFile(claimPath, body)) {
      return { acquired: true, lease: makeLease(claimPath, opts.runId) };
    }
    // A third party created a fresh claim in the tiny gap — respect it.
    return { acquired: false, reason: "busy" };
  } finally {
    // Always clean up our own tombstone.
    try {
      unlinkSync(tombstone);
    } catch {
      /* best-effort */
    }
  }
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
