/**
 * Git-worktree isolation for sub-agent fan-out (issue #66 P11). Each parallel
 * sub-agent runs in its own worktree under `.otto-tmp/wt/<id>` — a separate
 * working directory sharing the repo's object store, so the agents never clobber
 * each other's files. The dir is inside the workspace, so the native OS sandbox
 * still confines writes. `.otto-tmp/` is already gitignored.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Create an isolated worktree at HEAD under `.otto-tmp/wt/<id>`. `--detach` so
 * the sub-agent commits onto a detached HEAD without creating or moving a branch.
 * `cleanup()` removes the worktree (and its dir); it is idempotent and safe to
 * call from a `finally`.
 */
export function createWorktree(
  workspaceDir: string,
  id: string
): { dir: string; cleanup: () => void } {
  const rel = join(".otto-tmp", "wt", id);
  const dir = join(workspaceDir, rel);
  // Remove any stale worktree at this path first (a crashed prior run), then add.
  git(["worktree", "remove", "--force", dir], workspaceDir);
  rmSync(dir, { recursive: true, force: true });
  git(["worktree", "add", "--detach", dir, "HEAD"], workspaceDir);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    git(["worktree", "remove", "--force", dir], workspaceDir);
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

/**
 * Prune leftover worktrees from a crashed prior run: remove the `.otto-tmp/wt`
 * tree wholesale, then GC git's worktree registry so the stale entries don't
 * linger. Call once before a fan-out round.
 */
export function reapWorktrees(workspaceDir: string): void {
  rmSync(join(workspaceDir, ".otto-tmp", "wt"), { recursive: true, force: true });
  git(["worktree", "prune"], workspaceDir);
}
