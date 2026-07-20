/**
 * Verification evidence validation + relocation (issue #181 P24, re-review).
 *
 * The pure {@link isValidArtifactReference} checks an artifact reference's *shape*
 * only. This impure layer, run at finalize against the real workspace + git,
 * answers whether the cited proof actually **exists** — a source `file:line` whose
 * file is present and whose line is in bounds, or a commit SHA present in git —
 * and **relocates** scratch file artifacts (screenshots, transcripts the verify
 * stage wrote under `.otto-tmp/`) into the durable run bundle with bundle-relative
 * paths. Both close re-review gaps: agent-cited proof that doesn't exist no longer
 * earns coverage, and a malicious/absolute/`..` path can neither be counted nor
 * copied out of the workspace.
 *
 * INERT outside a `--verify` finalize; pure-ish (fs reads + copies into the
 * bundle, git injected for testability).
 */

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";

import { runReportDir } from "./run-report.js";
import {
  BUNDLE_ARTIFACT_PREFIX,
  isValidArtifactReference,
  type VerificationEntry,
} from "./verification-matrix.js";

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const FILE_LINE_RE = /^(.+?):(\d+)(?:-(\d+))?$/;

/** Tolerance absorbed into the "produced this run" (#201) mtime check. A file's
 *  stored mtime can be FLOORED below its true write time by the filesystem's
 *  timestamp granularity — commonly 1s on container overlay/tmpfs, up to 2s on
 *  FAT — so a screenshot written just after the run started can appear a hair
 *  OLDER than the sub-millisecond `startedAtMs` and be wrongly judged stale
 *  (a flaky CI failure that never reproduces on fine-grained APFS). A file from a
 *  genuinely PRIOR run is older by the whole run duration (many seconds), so a 2s
 *  slop closes the granularity gap without weakening the prior-run guard. */
const MTIME_GRANULARITY_SLOP_MS = 2_000;

export type EvidenceDeps = {
  /** Whether a commit SHA exists in the repo (e.g. `git.commitExists(workspaceDir, …)`). */
  commitExists: (sha: string) => boolean;
};

/**
 * Real on-disk path of `file` iff it resolves to a regular file **inside** the
 * workspace — rejecting `..` traversal, absolute escapes, and symlinks that point
 * outside (realpath is compared against the workspace's realpath). Null otherwise.
 */
function safeWorkspaceFile(file: string, workspaceDir: string): string | null {
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(file)) return null; // traversal
  const abs = isAbsolute(file) ? file : join(workspaceDir, file);
  let realWs: string;
  let real: string;
  try {
    realWs = realpathSync(workspaceDir);
  } catch {
    return null;
  }
  try {
    real = realpathSync(abs);
  } catch {
    return null; // does not exist
  }
  if (real !== realWs && !real.startsWith(realWs + sep)) return null; // escaped
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Whether an artifact reference points to evidence that actually exists: a commit
 * SHA present in git, or a file inside the workspace whose cited line range is in
 * bounds. Syntactically-invalid refs / URLs / traversal are rejected first.
 */
export function artifactReferenceExists(
  ref: string,
  workspaceDir: string,
  deps: EvidenceDeps
): boolean {
  const r = ref.trim();
  if (!isValidArtifactReference(r)) return false;
  if (SHA_RE.test(r)) return deps.commitExists(r);
  const m = FILE_LINE_RE.exec(r);
  const file = m ? m[1] : r;
  const real = safeWorkspaceFile(file, workspaceDir);
  if (!real) return false;
  if (m) {
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (start < 1 || end < start) return false;
    let lineCount: number;
    try {
      lineCount = readFileSync(real, "utf8").split("\n").length;
    } catch {
      return false;
    }
    if (end > lineCount) return false;
  }
  return true;
}

/**
 * Validate every entry's artifact against the filesystem/git (setting
 * `artifactExists`), and relocate any **scratch file** artifact (a plain path,
 * inside the workspace, that is not a `file:line`/SHA reference) into the run
 * bundle at `.otto/runs/<run-id>/verification/` with a bundle-relative path, so
 * the persisted report's links resolve and the files are durable. Source
 * `file:line` references and commit SHAs are durable already and left untouched;
 * a path that escapes the workspace is neither counted nor copied.
 */
export function validateVerificationEvidence(
  entries: VerificationEntry[],
  opts: {
    workspaceDir: string;
    runId: string;
    /** Run start (epoch ms). When set, a scratch artifact whose mtime predates it
     *  was produced by a PRIOR run and is rejected — neither counted as proof nor
     *  relocated into this run's bundle (issue #201). */
    startedAtMs?: number;
  } & EvidenceDeps
): VerificationEntry[] {
  const { workspaceDir, runId, startedAtMs, commitExists } = opts;
  let counter = 0;

  let scratchRoot: string | null = null;
  try {
    scratchRoot = realpathSync(join(workspaceDir, ".otto-tmp"));
  } catch {
    scratchRoot = null; // no scratch dir ⇒ nothing to relocate
  }

  // The physical run-bundle verification dir. Ensure the bundle dir exists, then
  // realpath it (stripping any symlinks ABOVE it) and require it to stay inside
  // the workspace; the copy destination is then this exact physical dir, and the
  // `verification/` component itself must not be a symlink (checked per copy).
  let destDir: string | null = null;
  try {
    const bundlePath = runReportDir(workspaceDir, runId);
    mkdirSync(bundlePath, { recursive: true });
    const bundleReal = realpathSync(bundlePath);
    const wsReal = realpathSync(workspaceDir);
    if (bundleReal === wsReal || bundleReal.startsWith(wsReal + sep)) {
      destDir = join(bundleReal, "verification");
    }
  } catch {
    destDir = null;
  }

  // A scratch file that predates the run start was produced by a prior run —
  // citing it as this run's proof is fabrication, so it is rejected (#201).
  const staleScratch = (real: string): boolean => {
    if (startedAtMs === undefined) return false;
    if (
      !scratchRoot ||
      (real !== scratchRoot && !real.startsWith(scratchRoot + sep))
    ) {
      return false; // not a scratch file — durable references have no run age
    }
    try {
      // Slop absorbs coarse filesystem mtime granularity (see the constant) so a
      // file written just after the run start is never mistaken for a prior run's.
      return statSync(real).mtimeMs < startedAtMs - MTIME_GRANULARITY_SLOP_MS;
    } catch {
      return true; // unreadable scratch file cannot prove anything
    }
  };

  // Whether a plain scratch-path artifact is stale (never true for `file:line`
  // or SHA references, which are durable by construction).
  const staleScratchRef = (p: string): boolean => {
    if (FILE_LINE_RE.test(p) || SHA_RE.test(p)) return false;
    const real = safeWorkspaceFile(p, workspaceDir);
    return real !== null && staleScratch(real);
  };

  const relocateScratch = (p: string): { path: string; bundled: boolean } => {
    const keep = { path: p, bundled: false };
    if (FILE_LINE_RE.test(p) || SHA_RE.test(p)) return keep; // a reference, not a file
    const real = safeWorkspaceFile(p, workspaceDir);
    // Only relocate scratch artifacts the verify stage wrote under `.otto-tmp/`
    // — never an arbitrary in-repo or host file (#181 re-review) and never one
    // left over from a previous run (#201).
    if (
      !real ||
      !destDir ||
      !scratchRoot ||
      (real !== scratchRoot && !real.startsWith(scratchRoot + sep)) ||
      staleScratch(real)
    ) {
      return keep;
    }
    try {
      mkdirSync(destDir, { recursive: true });
      // The destination must be the *physical* bundle verification dir: reject a
      // symlinked `verification/` (which could redirect the copy into a source
      // dir even while staying inside the workspace) by requiring its realpath to
      // equal the path itself (#181 boundary review).
      if (lstatSync(destDir).isSymbolicLink()) return keep;
      if (realpathSync(destDir) !== destDir) return keep;
      const safe = `${counter++}-${basename(p)}`
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 100);
      const target = join(destDir, safe);
      // Reject a pre-existing symlink at the target — copyFileSync would follow it.
      try {
        if (lstatSync(target).isSymbolicLink()) return keep;
      } catch {
        // absent target is the expected case
      }
      copyFileSync(real, target);
      return { path: `${BUNDLE_ARTIFACT_PREFIX}${safe}`, bundled: true };
    } catch {
      return keep; // best-effort: never fail finalize over a copy
    }
  };

  return entries.map((e) => {
    const next: VerificationEntry = { ...e };
    if (e.artifactPath !== undefined) {
      next.artifactExists =
        artifactReferenceExists(e.artifactPath, workspaceDir, {
          commitExists,
        }) && !staleScratchRef(e.artifactPath);
      const r = relocateScratch(e.artifactPath);
      next.artifactPath = r.path;
      next.artifactBundled = r.bundled;
    }
    if (e.beforePath !== undefined) {
      const r = relocateScratch(e.beforePath);
      next.beforePath = r.path;
      next.beforeBundled = r.bundled;
    }
    return next;
  });
}
