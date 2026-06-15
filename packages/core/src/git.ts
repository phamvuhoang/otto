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
