/** Read the per-repo journal opt-in from .otto/config.json (issue #67 P12). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalConfig } from "./journal.js";

/**
 * Read `.otto/config.json`'s `journal` block. Returns `null` (the hook no-ops)
 * unless `journal.enabled === true`. Autonomous posting requires BOTH
 * `journal.autonomous: true` in config AND `OTTO_JOURNAL_AUTONOMOUS` truthy — a
 * double opt-in. Missing/invalid file or block → null (zero behavior change).
 */
export function readJournalConfig(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): JournalConfig | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  const j = raw.journal as Record<string, unknown> | undefined;
  if (!j || typeof j !== "object" || j.enabled !== true) return null;

  const envAutonomous = ["1", "true", "yes", "on"].includes(
    (env.OTTO_JOURNAL_AUTONOMOUS ?? "").trim().toLowerCase()
  );
  return {
    enabled: true,
    autonomous: j.autonomous === true && envAutonomous,
    categories: Array.isArray(j.categories)
      ? (j.categories as unknown[]).filter(
          (c): c is string => typeof c === "string"
        )
      : ["gotcha", "dead-end"],
    minDaysBetweenPosts:
      typeof j.minDaysBetweenPosts === "number" ? j.minDaysBetweenPosts : 1,
  };
}
