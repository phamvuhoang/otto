/** Posted-entry ledger + cadence/dedup for the P12 journal (issue #67). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export type PostedEntry = {
  memoryId: string;
  contentHash: string;
  postedAt: string;
  postId?: string;
};

const ledgerPath = (workspaceDir: string): string =>
  join(workspaceDir, ".otto", "journal", "posted.json");

/** Stable short content hash, used for dedup of near-identical notes. */
export function hashContent(s: string): string {
  return createHash("sha256").update(s.trim()).digest("hex").slice(0, 16);
}

export function readLedger(workspaceDir: string): PostedEntry[] {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(workspaceDir), "utf8"));
    return Array.isArray(raw) ? (raw as PostedEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendLedger(workspaceDir: string, entry: PostedEntry): void {
  const path = ledgerPath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  const next = [...readLedger(workspaceDir), entry];
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

/** True if the newest post is younger than `minDays` before `now`. */
export function recentlyPosted(
  ledger: PostedEntry[],
  minDays: number,
  now: Date
): boolean {
  if (ledger.length === 0 || minDays <= 0) return false;
  const newest = ledger.reduce((a, b) => (a.postedAt > b.postedAt ? a : b));
  const ageMs = now.getTime() - new Date(newest.postedAt).getTime();
  return ageMs < minDays * 24 * 60 * 60 * 1000;
}
