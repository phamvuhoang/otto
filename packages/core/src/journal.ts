/**
 * P12 journal orchestrator (issue #67): select a memory learning → generate a
 * field note → run the default-deny secrecy gate → draft (default) or post
 * (autonomous). All model/network I/O is injected; never throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAudit, screenEntry, type GateContext } from "./journal-gate.js";
import { forbiddenTermsFor, selectCandidate } from "./journal-source.js";
import {
  appendLedger,
  hashContent,
  readLedger,
  recentlyPosted,
} from "./journal-ledger.js";
import { readMemoryRecords } from "./memory.js";
import type { AgentRuntimeId } from "./agent-runtime.js";
import { git } from "./git.js";
import { readJournalConfig } from "./journal-config.js";
import { readSafetyPolicy } from "./safety-policy.js";
import { executeStage } from "./stage-exec.js";
import { STAGES } from "./stages.js";
import { createThreadsClient, resolveThreadsAuth } from "./threads-api.js";

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

/** Collect this repo's own identifiers so the gate can deny self-references. */
function repoIdentifiers(workspaceDir: string): string[] {
  const ids = new Set<string>([basename(workspaceDir)]);
  const remote = git(["remote", "get-url", "origin"], workspaceDir);
  if (remote) {
    for (const part of remote.split(/[/:@.]/)) {
      const p = part.trim();
      if (
        p.length >= 3 &&
        !["https", "http", "git", "com", "org", "www", "ssh"].includes(
          p.toLowerCase()
        )
      ) {
        ids.add(p);
      }
    }
  }
  return [...ids];
}

/** The judge stage must emit exactly <journal-verdict>SAFE</journal-verdict>. */
function parseVerdict(result: string): boolean {
  return /<journal-verdict>\s*SAFE\s*<\/journal-verdict>/i.test(result);
}

/**
 * Harness run-end hook (issue #67 P12): read the per-repo journal config (no-op
 * when absent/disabled), build the real generate/judge/publish deps from the
 * agent runtime + Threads client, and run the journal. Never throws — the
 * journal must never affect a run's outcome.
 */
export async function maybeJournal(args: {
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  agentId: AgentRuntimeId;
  signal?: AbortSignal;
}): Promise<JournalOutcome> {
  try {
    const config = readJournalConfig(args.workspaceDir);
    if (!config) return { action: "disabled" };

    const stageArgs = {
      workspaceDir: args.workspaceDir,
      packageDir: args.packageDir,
      iteration: args.iteration,
      maxRetries: args.maxRetries,
      agentId: args.agentId,
      signal: args.signal,
    };
    // Resolve a Threads client only for an autonomous, credentialed run.
    const auth = config.autonomous ? resolveThreadsAuth() : null;
    const client = auth ? createThreadsClient(auth) : undefined;

    return await runJournal(args.workspaceDir, config, {
      generate: async (learning) =>
        (
          await executeStage({
            ...stageArgs,
            stage: STAGES.journalWrite,
            vars: { INPUTS: learning, RESUME: "" },
            logLabel: "journal-write",
          })
        ).result,
      judge: async (note) =>
        parseVerdict(
          (
            await executeStage({
              ...stageArgs,
              stage: STAGES.journalScreen,
              vars: { INPUTS: note, RESUME: "" },
              logLabel: "journal-screen",
            })
          ).result
        ),
      publish: client ? (text) => client.publish(text) : undefined,
      repoIdentifiers: repoIdentifiers(args.workspaceDir),
      secretPatterns: readSafetyPolicy(args.workspaceDir).secretPatterns,
      now: () => new Date(),
    });
  } catch {
    return { action: "denied", reason: "hook-error" };
  }
}
