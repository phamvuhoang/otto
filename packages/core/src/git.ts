import { execFileSync } from "node:child_process";

/**
 * Run git with literal args (no shell — args never interpolate runtime data).
 * Returns trimmed stdout, or null on any non-zero exit / missing repo.
 */
export function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/** True if any TRACKED file has uncommitted changes (untracked files ignored). */
export function hasUncommittedTrackedChanges(cwd: string): boolean {
  const s = git(["status", "--porcelain", "--untracked-files=no"], cwd);
  return s != null && s !== "";
}

/** True if `relPath` is gitignored in `cwd`. */
export function isPathIgnored(cwd: string, relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Current HEAD commit sha, or null outside a repo / on an unborn branch. */
export function headSha(cwd: string): string | null {
  return git(["rev-parse", "HEAD"], cwd);
}

/**
 * Tracked file paths that changed since `sinceSha` — the union of commits made
 * since then (`<sinceSha>..HEAD`) and any uncommitted staged/unstaged edits — so
 * the adaptive router sees the work an iteration produced whether or not the
 * agent committed it. `sinceSha` null (no prior HEAD) → just the working-tree
 * diff. Returns a de-duplicated list; never throws.
 */
export function changedFilesSince(
  cwd: string,
  sinceSha: string | null
): string[] {
  const out = new Set<string>();
  const collect = (raw: string | null) => {
    if (!raw) return;
    for (const line of raw.split("\n")) {
      const p = line.trim();
      if (p) out.add(p);
    }
  };
  if (sinceSha) collect(git(["diff", "--name-only", `${sinceSha}..HEAD`], cwd));
  collect(git(["diff", "--name-only", "HEAD"], cwd)); // unstaged + staged vs HEAD
  return [...out];
}

/** True if a local branch/ref named `name` already exists. */
export function refExists(cwd: string, name: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      { cwd, stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `sha` (a 7–40 char hex string) names a commit object that actually
 * exists in the repo at `cwd` (issue #181 re-review). Used to reject fabricated
 * commit SHAs cited as verification artifacts. False for non-hex input or any
 * git error (not a repo, object absent).
 */
export function commitExists(cwd: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
