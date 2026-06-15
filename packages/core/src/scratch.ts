import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Prefixes of the ephemeral entries Otto writes under `<workspaceDir>/.otto-tmp/`:
 * rendered prompts (`.run-*`), transient sandbox settings (`.sandbox-*`), spill
 * dirs (`spill-*`), and review-panel dirs (`panel-*`). The per-stage `finally`
 * blocks in runner.ts / panel.ts remove these on a clean exit, but the
 * SIGINT/SIGTERM handlers call `process.exit()` synchronously, which pre-empts
 * those finallys — so the interrupt path sweeps them via {@link cleanScratch}.
 * Persistent entries (`logs/`, `worktrees/`) are deliberately preserved.
 */
export const EPHEMERAL_SCRATCH_PREFIXES = [
  ".run-",
  ".sandbox-",
  "spill-",
  "panel-",
];

/**
 * Synchronously remove ephemeral scratch artifacts from `<workspaceDir>/.otto-tmp/`.
 * Safe when the dir is absent (no-op) and best-effort per entry (a single
 * unremovable entry never throws), so the interrupt path can always exit cleanly.
 */
export function cleanScratch(workspaceDir: string): void {
  const tmpDir = join(workspaceDir, ".otto-tmp");
  let entries: string[];
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!EPHEMERAL_SCRATCH_PREFIXES.some((p) => name.startsWith(p))) continue;
    try {
      rmSync(join(tmpDir, name), { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover scratch entry must never block a clean exit.
    }
  }
}
