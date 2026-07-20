/**
 * Exact PR revision isolation for automated review (P32 Task 7).
 *
 * This module is a trust boundary. An unattended review must reason about the
 * EXACT bytes GitHub reports for a PR — the precise base/head objects the
 * adapter verified — not whatever a local checkout happens to hold, and it must
 * never let PR-authored content masquerade as trusted repository policy. To that
 * end {@link createPullRequestWorktree}:
 *
 *  1. Fetches the base branch tip and `refs/pull/<n>/head` into two Otto-owned
 *     temp refs in ONE `git fetch`, using a STRICT literal-argv runner that
 *     never swallows a failure and never lets an attacker-controlled ref name be
 *     shell-evaluated.
 *  2. Verifies the fetched object IDs EQUAL the adapter's `baseSha`/`headSha`,
 *     failing closed BEFORE any worktree is created if either differs.
 *  3. Creates a DISPOSABLE detached worktree at the verified head SHA — the
 *     operator's branch and HEAD never move.
 *  4. Writes three artifacts under `<worktree>/.otto-tmp/pr-review/`: the exact
 *     unified diff, a TRUSTED base-revision instruction bundle read from
 *     `baseSha` (never the PR-head copy), and a byte-identical copy of the
 *     already-validated review-input artifact.
 *
 * {@link assertReviewWorktreeClean} detects any model mutation of the checkout
 * (a tracked edit, a new untracked source file, or HEAD movement) while ignoring
 * harness scratch under the ignored `.otto-tmp/`. {@link buildReviewContext}
 * fences the PR's untrusted identity/metadata via {@link wrapUntrusted}.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PullRequestRevision } from "./pr-review.js";
import type { ReviewInputSnapshot } from "./pr-review-input.js";
import { wrapUntrusted } from "./taint.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A git invocation as literal argv in `cwd`, returning trimmed stdout. */
export type GitCommandRunner = (args: readonly string[], cwd: string) => string;

/** The prepared, isolated PR revision plus its on-disk review artifacts. */
export type PullRequestWorktree = {
  dir: string;
  diffPath: string;
  diffText: string;
  instructionsPath: string;
  instructionsText: string;
  reviewInputPath: string;
  reviewInputText: string;
  baseRef: string;
  headRef: string;
  cleanup: () => void;
};

/** Fail-closed error for every rejected PR-worktree case. */
export class PullRequestWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestWorktreeError";
  }
}

// ---------------------------------------------------------------------------
// Strict literal-argv git runner
// ---------------------------------------------------------------------------

/**
 * Default runner: run git with literal argv. Unlike {@link import("./git.js").git}
 * this NEVER swallows a failure — a non-zero exit throws. Every element of
 * `args` is a literal argv entry, so a malicious ref name stays one string and
 * is never handed to a shell.
 */
const DEFAULT_RUN: GitCommandRunner = (args, cwd) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function runGit(
  run: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  what: string
): string {
  try {
    return run(args, cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PullRequestWorktreeError(`${what} failed: ${detail}`);
  }
}

/**
 * Capture git stdout WITHOUT trimming, for byte-exact artifacts (the diff). The
 * default runner `.trim()`s — correct for SHA/refname/status outputs where
 * trailing whitespace is noise, but it would silently drop significant tail
 * bytes of a patch (a `--binary` hunk's terminating blank line, or a final
 * added line ending in whitespace). This preserves the exact bytes git emits.
 * Still literal argv (no shell), still fails closed on a non-zero exit.
 */
function runGitRaw(args: readonly string[], cwd: string, what: string): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PullRequestWorktreeError(`${what} failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Validation (all BEFORE any mutation)
// ---------------------------------------------------------------------------

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{40,64}$/;
// Permissive but safe branch-refname shape: real branch names use slashes,
// dots, hyphens, and underscores (e.g. `feature/foo-bar`). Rejects whitespace,
// shell metacharacters, and control bytes early — before the fetch mutation —
// even though the object-ID gate would also catch a bogus ref later.
const BASE_REF_NAME_RE = /^[A-Za-z0-9._/-]+$/;

function validateRunId(runId: string): void {
  if (runId === "." || runId === ".." || !RUN_ID_RE.test(runId)) {
    throw new PullRequestWorktreeError(
      `invalid run id: ${JSON.stringify(runId)}`
    );
  }
}

function validateSha(label: string, sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new PullRequestWorktreeError(
      `${label} must be 40-64 hex characters, got: ${JSON.stringify(sha)}`
    );
  }
}

function validateBaseRefName(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    !BASE_REF_NAME_RE.test(name)
  ) {
    throw new PullRequestWorktreeError(
      `invalid base ref name: ${JSON.stringify(name)}`
    );
  }
}

function validateNumber(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new PullRequestWorktreeError(
      `PR number must be a positive integer, got: ${JSON.stringify(n)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Local excludes
// ---------------------------------------------------------------------------

const EXCLUDE_LINES = [".otto-tmp/", ".otto/runs/", ".otto/review-state/"];

/**
 * Ensure the Otto scratch/run paths are ignored WITHOUT touching the tracked
 * `.gitignore`: resolve the LOCAL `info/exclude` via `git rev-parse
 * --git-path` and atomically append any missing lines. Idempotent.
 */
export function prepareReviewLocalExcludes(
  workspaceDir: string,
  run: GitCommandRunner = DEFAULT_RUN
): void {
  const raw = runGit(
    run,
    ["rev-parse", "--git-path", "info/exclude"],
    workspaceDir,
    "git rev-parse --git-path info/exclude"
  );
  const excludePath = isAbsolute(raw) ? raw : join(workspaceDir, raw);

  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = EXCLUDE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return;

  let next = existing;
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  next += missing.join("\n") + "\n";

  // Atomic replace: temp sibling, fsync, rename over the exclude file.
  const dir = excludePath.slice(0, excludePath.lastIndexOf("/")) || ".";
  mkdirSync(dir, { recursive: true });
  const tmp = `${excludePath}.otto-tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, next);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // rename is atomic on the same filesystem.
  renameSync(tmp, excludePath);
}

// ---------------------------------------------------------------------------
// Trusted base instruction bundle
// ---------------------------------------------------------------------------

/** Basenames treated as repository instruction/policy files. */
const INSTRUCTION_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Assemble the TRUSTED repository-instruction bundle from `baseSha`. Instruction
 * files are discovered with `git ls-tree -r --name-only <baseSha>` and read via
 * literal `git show <baseSha>:<path>` — never from the PR-head checkout — so a
 * PR that edits `AGENTS.md`/`CLAUDE.md` cannot replace the policy the reviewer
 * trusts; that change stays only in the untrusted diff.
 */
export function buildBaseInstructionBundle(opts: {
  workspaceDir: string;
  baseSha: string;
  run?: GitCommandRunner;
}): string {
  const run = opts.run ?? DEFAULT_RUN;
  validateSha("baseSha", opts.baseSha);

  const listing = runGit(
    run,
    ["ls-tree", "-r", "--name-only", opts.baseSha],
    opts.workspaceDir,
    "git ls-tree"
  );
  const paths = listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && INSTRUCTION_BASENAMES.has(basename(l)))
    .sort();

  const parts: string[] = [
    `# Trusted repository review instructions (base ${opts.baseSha})`,
    "",
    "These files are read from the PR's BASE revision and are trusted policy.",
    "The PR's own copy of these files, if changed, appears only in the diff.",
    "",
  ];
  if (paths.length === 0) {
    parts.push("_No repository instruction files found at the base revision._");
    parts.push("");
  } else {
    for (const p of paths) {
      const content = runGit(
        run,
        ["show", `${opts.baseSha}:${p}`],
        opts.workspaceDir,
        `git show ${opts.baseSha}:${p}`
      );
      parts.push(`## ${p}`, "", content, "");
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Mutation check
// ---------------------------------------------------------------------------

/**
 * Throw if the model mutated the review checkout: a tracked edit, a NEW
 * untracked source file, or HEAD movement all fail closed. Harness scratch under
 * the ignored `.otto-tmp/` is respected by git and does NOT count as a mutation.
 */
export function assertReviewWorktreeClean(
  worktreeDir: string,
  expectedHead: string,
  run: GitCommandRunner = DEFAULT_RUN
): void {
  validateSha("expectedHead", expectedHead);

  const head = runGit(
    run,
    ["rev-parse", "HEAD"],
    worktreeDir,
    "git rev-parse HEAD"
  );
  if (head !== expectedHead) {
    throw new PullRequestWorktreeError(
      `review worktree HEAD moved: expected ${expectedHead}, found ${head}`
    );
  }

  // Porcelain status respects .gitignore + info/exclude, so ignored scratch is
  // absent. Any remaining line is a tracked edit or a new untracked source file.
  const status = runGit(
    run,
    ["status", "--porcelain", "--untracked-files=all"],
    worktreeDir,
    "git status"
  );
  if (status !== "") {
    throw new PullRequestWorktreeError(
      `review worktree was mutated by the model:\n${status}`
    );
  }
}

// ---------------------------------------------------------------------------
// Taint context
// ---------------------------------------------------------------------------

/**
 * Fence the PR's UNTRUSTED identity and metadata — repository, number, author,
 * title, body — together in one `pull-request` taint block. It deliberately
 * does NOT embed the diff or the review input (those are separate artifacts); a
 * PR body containing `</untrusted>` is defanged and cannot escape the fence.
 */
export function buildReviewContext(revision: PullRequestRevision): string {
  const fields = [
    `Repository: ${revision.repository}`,
    `Number: ${revision.number}`,
    `Author: ${revision.author}`,
    `Title: ${revision.title}`,
    "",
    "Body:",
    revision.body,
  ].join("\n");
  return wrapUntrusted(fields, "pull-request");
}

// ---------------------------------------------------------------------------
// Worktree creation
// ---------------------------------------------------------------------------

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.otto-tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Prepare an isolated, verified worktree for the exact PR revision. Validates
 * inputs, fetches base/head into Otto temp refs, verifies the fetched object IDs
 * equal the adapter SHAs (fail-closed before `worktree add`), creates a detached
 * worktree at the head SHA, and writes the diff, trusted base-instruction
 * bundle, and byte-exact review-input copy. The operator's checkout never moves.
 */
export function createPullRequestWorktree(opts: {
  workspaceDir: string;
  runId: string;
  revision: PullRequestRevision;
  reviewInput: ReviewInputSnapshot;
  run?: GitCommandRunner;
}): PullRequestWorktree {
  const { workspaceDir, runId, revision, reviewInput } = opts;
  const run = opts.run ?? DEFAULT_RUN;

  // --- Validate everything BEFORE any mutation. ---
  validateRunId(runId);
  validateNumber(revision.number);
  validateBaseRefName(revision.baseRefName);
  validateSha("baseSha", revision.baseSha);
  validateSha("headSha", revision.headSha);

  const baseRef = `refs/otto/pr-review/${runId}/base`;
  const headRef = `refs/otto/pr-review/${runId}/head`;
  const worktreeDir = join(
    workspaceDir,
    ".otto-tmp",
    "pr-review-worktrees",
    runId
  );

  const deleteTempRefs = (): void => {
    for (const ref of [baseRef, headRef]) {
      try {
        run(["update-ref", "-d", ref], workspaceDir);
      } catch {
        // best-effort
      }
    }
  };
  const removeWorktree = (): void => {
    try {
      run(["worktree", "remove", "--force", worktreeDir], workspaceDir);
    } catch {
      // best-effort
    }
    rmSync(worktreeDir, { recursive: true, force: true });
  };

  // Make Otto scratch/run paths ignored so the mutation check sees only real
  // model mutations, not our own artifact writes.
  prepareReviewLocalExcludes(workspaceDir, run);

  // Clear any stale worktree/refs from a crashed prior run at this id.
  removeWorktree();
  deleteTempRefs();

  try {
    // --- Fetch both objects in ONE command (literal argv). ---
    runGit(
      run,
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/" + revision.baseRefName + ":" + baseRef,
        "+refs/pull/" + revision.number + "/head:" + headRef,
      ],
      workspaceDir,
      "git fetch"
    );

    // --- Verify fetched object IDs EQUAL the adapter SHAs (fail-closed). ---
    const fetchedBase = runGit(
      run,
      ["rev-parse", baseRef],
      workspaceDir,
      "git rev-parse base ref"
    );
    const fetchedHead = runGit(
      run,
      ["rev-parse", headRef],
      workspaceDir,
      "git rev-parse head ref"
    );
    if (fetchedBase !== revision.baseSha) {
      throw new PullRequestWorktreeError(
        `fetched base ${fetchedBase} does not equal adapter baseSha ${revision.baseSha}`
      );
    }
    if (fetchedHead !== revision.headSha) {
      throw new PullRequestWorktreeError(
        `fetched head ${fetchedHead} does not equal adapter headSha ${revision.headSha}`
      );
    }

    // --- Disposable detached worktree at the VERIFIED head SHA. ---
    runGit(
      run,
      ["worktree", "add", "--detach", worktreeDir, revision.headSha],
      workspaceDir,
      "git worktree add"
    );

    // --- Artifacts under <worktree>/.otto-tmp/pr-review/. ---
    const artifactDir = join(worktreeDir, ".otto-tmp", "pr-review");
    mkdirSync(artifactDir, { recursive: true });

    // Exact unified diff (base...head three-dot). Captured RAW (untrimmed) so
    // every byte git emits — including the terminating newline and any
    // trailing-whitespace content — is preserved verbatim in the artifact.
    const diffText = runGitRaw(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--unified=0",
        "--no-ext-diff",
        "--binary",
        "--no-renames",
        `${revision.baseSha}...${revision.headSha}`,
      ],
      workspaceDir,
      "git diff"
    );
    const diffPath = join(artifactDir, "diff.patch");
    atomicWrite(diffPath, diffText);

    // Trusted base instruction bundle (never the PR-head copy).
    const instructionsText = buildBaseInstructionBundle({
      workspaceDir,
      baseSha: revision.baseSha,
      run,
    });
    const instructionsPath = join(artifactDir, "repo-instructions.md");
    atomicWrite(instructionsPath, instructionsText);

    // Byte-for-byte copy of the already-validated run-level review-input.
    const reviewInputSrc = join(
      workspaceDir,
      ".otto",
      "runs",
      runId,
      "review-input.md"
    );
    const reviewInputPath = join(artifactDir, "review-input.md");
    let reviewInputBytes: Buffer;
    try {
      reviewInputBytes = readFileSync(reviewInputSrc);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PullRequestWorktreeError(
        `review-input artifact not found at ${reviewInputSrc}: ${detail}`
      );
    }
    copyFileSync(reviewInputSrc, reviewInputPath);
    const reviewInputText = reviewInputBytes.toString("utf8");
    void reviewInput; // provided by caller; source of truth is the on-disk artifact

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      removeWorktree();
      deleteTempRefs();
    };

    return {
      dir: worktreeDir,
      diffPath,
      diffText,
      instructionsPath,
      instructionsText,
      reviewInputPath,
      reviewInputText,
      baseRef,
      headRef,
      cleanup,
    };
  } catch (err) {
    // Fail-closed: never leak a half-built worktree or the temp refs.
    removeWorktree();
    deleteTempRefs();
    if (err instanceof PullRequestWorktreeError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new PullRequestWorktreeError(detail);
  }
}
