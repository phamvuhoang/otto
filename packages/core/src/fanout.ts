/**
 * Sub-agent fan-out executor (issue #66 P11). Groups a plan's tasks into waves
 * of independent work (disjoint file scope, deps satisfied). Within a wave it
 * runs each task's sub-agent concurrently in its own git worktree, then a
 * synthesizer cherry-picks the per-task commits back onto the workspace HEAD
 * **serially** (the workspace index is shared, so merges must not race). Any
 * conflict, empty commit, or sub-agent error defers the task to the normal
 * sequential loop — fan-out never leaves the tree conflicted or half-merged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentRuntimeId } from "./agent-runtime.js";
import type { CbmIndexIdentity } from "./codebase-memory-adapter.js";
import type { RetrievalStore } from "./context-compressor.js";
import { changedFilesSince, git, headSha } from "./git.js";
import { parseHandoff, type SubAgentHandoff } from "./handoff.js";
import type { TierLadder } from "./model-tier.js";
import {
  planParallelGroups,
  predictConflicts,
  type ConflictPrediction,
  type PlanTask,
} from "./plan-tasks.js";
import type { StageResult } from "./runner.js";
import { executeStage } from "./stage-exec.js";
import { STAGES } from "./stages.js";
import { createWorktree } from "./worktree.js";

export type FanoutTaskStatus = "landed" | "deferred";

export type FanoutTaskOutcome = {
  task: PlanTask;
  status: FanoutTaskStatus;
  reason?: string;
  /** The sub-agent's structured handoff, when one could be read (or derived). */
  handoff?: SubAgentHandoff;
};

export type FanoutResult = {
  outcomes: FanoutTaskOutcome[];
  /** Tasks that did not land cleanly and must be re-run sequentially. */
  deferred: PlanTask[];
  /** Cross-task interaction notes (shared files, out-of-scope touches,
   *  deferrals) surfaced by the synthesizer; `""` when nothing noteworthy. */
  crossTaskSummary: string;
};

/**
 * Reorder `tasks` by ascending conflict risk (safest first): highest scope
 * confidence, fewest predicted overlaps. Pure — the caller decides how to use
 * the order (P25 Task 3: Phase B merges the lowest-risk worktrees first).
 */
export function orderByConflictRisk(
  tasks: PlanTask[],
  predictions: ConflictPrediction[]
): PlanTask[] {
  const score = (id: string) => {
    const p = predictions.find((x) => x.taskId === id);
    return p ? p.confidence - p.overlapsWith.length : 1;
  };
  return [...tasks].sort((a, b) => score(b.id) - score(a.id));
}

/**
 * Summarize cross-task interactions worth a human's attention: out-of-scope
 * touches reported by a sub-agent's handoff, and deferrals with their reason.
 * `""` when no outcome has anything noteworthy to report.
 */
export function buildCrossTaskSummary(outcomes: FanoutTaskOutcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const oos = o.handoff?.outOfScopeFiles ?? [];
    if (oos.length)
      lines.push(`- ${o.task.id} touched out-of-scope: ${oos.join(", ")}`);
    if (o.status === "deferred")
      lines.push(`- ${o.task.id} deferred: ${o.reason ?? "unknown"}`);
  }
  return lines.length ? `Cross-task interactions:\n${lines.join("\n")}` : "";
}

/**
 * Per-worktree retrieval identity (P25 Task 7, the seam for P26): stamps a
 * fan-out worktree with the workspace it lives in and the sha it was built
 * from, so a codebase-memory index built inside one worktree is never
 * mistaken for another's (or trusted once the worktree's HEAD has moved on).
 * Pure. Only computed when `bindWorktreeIdentity` is on; otherwise unused —
 * P26 is the only consumer.
 */
export function worktreeIndexIdentity(
  dir: string,
  before: string
): Pick<CbmIndexIdentity, "workspace" | "sourceRevision" | "worktreeDirty"> {
  return { workspace: dir, sourceRevision: before, worktreeDirty: false };
}

export type RunFanoutOptions = {
  tasks: PlanTask[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  concurrency: number;
  ladder: TierLadder;
  routing: boolean;
  runtimeId: AgentRuntimeId;
  signal?: AbortSignal;
  /**
   * Real paths named in the plan doc (spec.md + plan.md), from
   * {@link extractPlanFileMap}. Threaded into Phase B's conflict prediction so
   * `scopeConfidence` varies per task and merge order is non-inert (P25 Task
   * 3). Optional; `[]` (fan-out without `--plan`) reproduces prior uniform-
   * confidence ordering.
   */
  planFileMap?: string[];
  /**
   * The parallel per-task work: implement `task` inside `worktreeDir` and commit
   * there. Injectable so tests don't spawn a model; defaults to the
   * sub-implementer stage. A throw defers the task (its worktree is discarded).
   */
  runSubAgent?: (task: PlanTask, worktreeDir: string) => Promise<void>;
  /** Called with each default sub-agent's result so the loop rolls its cost +
   *  tokens into the run total (budget/pacing). Not called for an injected
   *  `runSubAgent`. */
  onSubAgent?: (sr: StageResult) => void;
  /** The run's retrieval store (issue #112 P20's `runRetrievalStore`), passed
   *  through to each sub-agent's `executeStage` call exactly as the
   *  sequential loop already does. Optional; absent ⇒ no retrieval store is
   *  threaded (today's behavior — fan-out never passed one). */
  retrievalStore?: RetrievalStore;
  /** P25/P26 seam: when true, stamp each built worktree with a
   *  {@link worktreeIndexIdentity} so a codebase-memory index built inside
   *  one worktree can't be mistaken for another's. Default false ⇒ inert;
   *  only meaningful once the `codebase-memory` tool is enabled. */
  bindWorktreeIdentity?: boolean;
};

/** Bounded-concurrency map: at most `limit` promises in flight at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** Default parallel phase: run the sub-implementer stage in the worktree. */
function defaultRunSubAgent(
  opts: RunFanoutOptions
): (task: PlanTask, worktreeDir: string) => Promise<void> {
  return async (task, worktreeDir) => {
    const sr = await executeStage({
      stage: STAGES.subImplementer,
      vars: {
        RESUME: "",
        TASK_TITLE: task.title,
        TASK_SCOPE: task.fileScope.join("\n"),
      },
      workspaceDir: worktreeDir,
      packageDir: opts.packageDir,
      iteration: opts.iteration,
      maxRetries: opts.maxRetries,
      signal: opts.signal,
      agentId: opts.runtimeId,
      modelRouting: opts.routing,
      tierLadder: opts.ladder,
      logLabel: `sub-${task.id}`,
      // The worktree's shared `.git` lives in the parent repo, outside the
      // worktree dir — allow writes there so `git commit` works under the
      // sandbox runner (issue #66 P11).
      sandboxWriteRoots: [opts.workspaceDir],
      // Absent unless the caller threads one (P25 Task 7); undefined here
      // reproduces today's behavior exactly.
      retrievalStore: opts.retrievalStore,
    });
    opts.onSubAgent?.(sr);
  };
}

/** A worktree + the sha it started at, captured for the serial merge phase. */
type Built = {
  task: PlanTask;
  dir: string;
  before: string | null;
  cleanup: () => void;
  /** Set when the parallel phase failed before producing a usable commit. */
  failure?: string;
  /** Per-worktree retrieval identity (P25 Task 7), present only when
   *  `bindWorktreeIdentity` is on. Consumed only by P26; otherwise unused. */
  identity?: Pick<
    CbmIndexIdentity,
    "workspace" | "sourceRevision" | "worktreeDirty"
  >;
};

/**
 * Read a built worktree's `handoff.json` (written by the subtask template)
 * and parse it. Throws-free: a missing/unreadable file degrades to `""`,
 * which `parseHandoff` turns into its fallback (the worktree's git-diff file
 * list since `before`) — never blocks the merge on a malformed handoff.
 */
function readSubAgentHandoff(b: Built): SubAgentHandoff {
  let raw = "";
  try {
    raw = readFileSync(join(b.dir, "handoff.json"), "utf8");
  } catch {
    raw = "";
  }
  return parseHandoff(raw, b.task.id, changedFilesSince(b.dir, b.before));
}

/**
 * Run the plan's tasks wave-by-wave. Phase A (parallel, bounded by
 * `concurrency`): each task runs its sub-agent in a fresh worktree. Phase B
 * (serial): cherry-pick each worktree's new commit(s) onto the workspace HEAD;
 * a conflict / empty commit / sub-agent error defers the task. Worktrees are
 * always cleaned up.
 */
export async function runFanout(opts: RunFanoutOptions): Promise<FanoutResult> {
  const runSubAgent = opts.runSubAgent ?? defaultRunSubAgent(opts);
  const waves = planParallelGroups(opts.tasks);
  const outcomes: FanoutTaskOutcome[] = [];

  for (const wave of waves) {
    if (opts.signal?.aborted) {
      for (const task of wave)
        outcomes.push({ task, status: "deferred", reason: "aborted" });
      continue;
    }

    // Create one worktree per task up front (serial — git worktree add mutates
    // .git), then run the sub-agents concurrently inside them.
    const built: Built[] = wave.map((task) => {
      const wt = createWorktree(
        opts.workspaceDir,
        `${opts.iteration}-${task.id}`
      );
      const before = headSha(wt.dir);
      return {
        task,
        dir: wt.dir,
        before,
        cleanup: wt.cleanup,
        identity: opts.bindWorktreeIdentity
          ? worktreeIndexIdentity(wt.dir, before ?? "")
          : undefined,
      };
    });

    try {
      // Phase A — parallel sub-agents.
      await mapPool(built, opts.concurrency, async (b) => {
        try {
          await runSubAgent(b.task, b.dir);
        } catch (err) {
          b.failure = `sub-agent error: ${(err as Error).message}`;
        }
      });

      // Phase B — serial cherry-pick onto the workspace HEAD. Merge
      // lowest-conflict-risk tasks first (P25 Task 3): predicted overlaps are
      // computed from the wave's own declared scopes, reconciled against the
      // caller's plan file map — when one is supplied, `scopeConfidence`
      // varies per task and actually drives the merge order; `[]` degrades to
      // uniform confidence (fewest-overlaps ordering only).
      const predictions = predictConflicts(wave, opts.planFileMap ?? []);
      const orderedTasks = orderByConflictRisk(wave, predictions);
      const orderedBuilt = orderedTasks.map(
        (t) => built.find((b) => b.task.id === t.id)!
      );

      for (const b of orderedBuilt) {
        const handoff = readSubAgentHandoff(b);
        if (b.failure) {
          outcomes.push({
            task: b.task,
            status: "deferred",
            reason: b.failure,
            handoff,
          });
          continue;
        }
        const after = headSha(b.dir);
        if (!after || after === b.before) {
          outcomes.push({
            task: b.task,
            status: "deferred",
            reason: "no commit produced",
            handoff,
          });
          continue;
        }
        const picked = git(
          ["cherry-pick", `${b.before}..${after}`],
          opts.workspaceDir
        );
        if (picked == null) {
          git(["cherry-pick", "--abort"], opts.workspaceDir);
          const riskNote = handoff.risks.length
            ? `; risks: ${handoff.risks.join(", ")}`
            : "";
          outcomes.push({
            task: b.task,
            status: "deferred",
            reason: `cherry-pick conflict${riskNote}`,
            handoff,
          });
          continue;
        }
        outcomes.push({ task: b.task, status: "landed", handoff });
      }
    } finally {
      for (const b of built) b.cleanup();
    }
  }

  return {
    outcomes,
    deferred: outcomes
      .filter((o) => o.status === "deferred")
      .map((o) => o.task),
    crossTaskSummary: buildCrossTaskSummary(outcomes),
  };
}
