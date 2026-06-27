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
  opts: { workspaceDir: string; runId: string } & EvidenceDeps
): VerificationEntry[] {
  const { workspaceDir, runId, commitExists } = opts;
  const destDir = join(runReportDir(workspaceDir, runId), "verification");
  let counter = 0;

  let wsReal: string | null = null;
  try {
    wsReal = realpathSync(workspaceDir);
  } catch {
    wsReal = null;
  }
  let scratchRoot: string | null = null;
  try {
    scratchRoot = realpathSync(join(workspaceDir, ".otto-tmp"));
  } catch {
    scratchRoot = null; // no scratch dir ⇒ nothing to relocate
  }
  const relocateScratch = (p: string): string => {
    if (FILE_LINE_RE.test(p) || SHA_RE.test(p)) return p; // a reference, not a file
    const real = safeWorkspaceFile(p, workspaceDir);
    // Only relocate scratch artifacts the verify stage wrote under `.otto-tmp/`
    // — never an arbitrary in-repo or host file (#181 re-review, finding 1).
    if (
      !real ||
      !wsReal ||
      !scratchRoot ||
      (real !== scratchRoot && !real.startsWith(scratchRoot + sep))
    ) {
      return p;
    }
    try {
      mkdirSync(destDir, { recursive: true });
      // The destination must also stay inside the workspace: a symlinked
      // `.otto/runs/<id>/verification` dir would otherwise let the copy escape
      // the bundle (#181 boundary review).
      const destReal = realpathSync(destDir);
      if (destReal !== wsReal && !destReal.startsWith(wsReal + sep)) return p;
      const safe = `${counter++}-${basename(p)}`
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 100);
      const target = join(destReal, safe);
      // Reject a pre-existing symlink at the target — copyFileSync would follow it.
      try {
        if (lstatSync(target).isSymbolicLink()) return p;
      } catch {
        // absent target is the expected case
      }
      copyFileSync(real, target);
      return `${BUNDLE_ARTIFACT_PREFIX}${safe}`; // relative to report.md / manifest.json
    } catch {
      return p; // best-effort: never fail finalize over a copy
    }
  };

  return entries.map((e) => {
    const next: VerificationEntry = { ...e };
    if (e.artifactPath !== undefined) {
      next.artifactExists = artifactReferenceExists(
        e.artifactPath,
        workspaceDir,
        {
          commitExists,
        }
      );
      next.artifactPath = relocateScratch(e.artifactPath);
    }
    if (e.beforePath !== undefined) {
      next.beforePath = relocateScratch(e.beforePath);
    }
    return next;
  });
}
