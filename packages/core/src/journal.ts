/**
 * P12 journal orchestrator (issue #67): select a memory learning → generate a
 * field note → run the default-deny secrecy gate → draft (default) or post
 * (autonomous). All model/network I/O is injected; never throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, screenEntry, type GateContext } from "./journal-gate.js";
import { forbiddenTermsFor, selectCandidate } from "./journal-source.js";
import {
  appendLedger,
  hashContent,
  readLedger,
  recentlyPosted,
} from "./journal-ledger.js";
import { readMemoryRecords } from "./memory.js";

export type JournalConfig = {
  enabled: boolean;
  autonomous: boolean;
  categories: string[];
  minDaysBetweenPosts: number;
};

export type JournalDeps = {
  /** Rewrite a learning as a generic field note (or "SKIP"). */
  generate: (learning: string) => Promise<string>;
  /** Adversarial judge: true = SAFE to post. */
  judge: (note: string) => Promise<boolean>;
  /** Publish to Threads; absent ⇒ draft-only (default mode). */
  publish?: (text: string) => Promise<{ id: string }>;
  repoIdentifiers: string[];
  secretPatterns: string[];
  now: () => Date;
};

export type JournalAction =
  | "disabled"
  | "no-candidate"
  | "skipped-cadence"
  | "denied"
  | "drafted"
  | "posted";
export type JournalOutcome = { action: JournalAction; reason?: string };

/**
 * The pure-ish orchestrator. Drafts by default; posts only when `autonomous`
 * and a `publish` dep are both present AND every gate passes. Default-deny and
 * never-throw are the invariants.
 */
export async function runJournal(
  workspaceDir: string,
  config: JournalConfig,
  deps: JournalDeps
): Promise<JournalOutcome> {
  try {
    if (!config.enabled) return { action: "disabled" };
    const now = deps.now();

    const ledger = readLedger(workspaceDir);
    if (recentlyPosted(ledger, config.minDaysBetweenPosts, now)) {
      return { action: "skipped-cadence" };
    }

    const postedIds = new Set(ledger.map((e) => e.memoryId));
    const candidate = selectCandidate(readMemoryRecords(workspaceDir), {
      categories: config.categories,
      postedIds,
      now,
    });
    if (!candidate) return { action: "no-candidate" };

    const note = (await deps.generate(candidate.content)).trim();
    const ctx: GateContext = {
      repoIdentifiers: deps.repoIdentifiers,
      secretPatterns: deps.secretPatterns,
      forbiddenTerms: forbiddenTermsFor(candidate),
    };
    const verdict =
      note === "SKIP" || note === ""
        ? { ok: false as const, gate: 1 as const, reason: "deny:generation-skip" }
        : await screenEntry(note, ctx, deps.judge);

    if (!verdict.ok) {
      appendAudit(workspaceDir, {
        at: now.toISOString(),
        memoryId: candidate.id,
        decision: "denied",
        gate: verdict.gate,
        reason: verdict.reason,
      });
      return { action: "denied", reason: verdict.reason };
    }

    // Passed every gate. Default mode drafts; autonomous posts.
    if (!config.autonomous || !deps.publish) {
      const dir = join(workspaceDir, ".otto", "journal", "drafts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${candidate.id}.md`), note + "\n", "utf8");
      appendAudit(workspaceDir, {
        at: now.toISOString(),
        memoryId: candidate.id,
        decision: "drafted",
      });
      return { action: "drafted" };
    }

    const { id } = await deps.publish(note);
    appendLedger(workspaceDir, {
      memoryId: candidate.id,
      contentHash: hashContent(note),
      postedAt: now.toISOString(),
      postId: id,
    });
    appendAudit(workspaceDir, {
      at: now.toISOString(),
      memoryId: candidate.id,
      decision: "posted",
      postId: id,
    });
    return { action: "posted" };
  } catch (err) {
    appendAudit(workspaceDir, {
      decision: "error",
      reason: (err as Error).message,
    });
    return { action: "denied", reason: "error" };
  }
}
