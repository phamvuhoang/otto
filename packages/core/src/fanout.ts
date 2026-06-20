/**
 * Sub-agent fan-out executor (issue #66 P11). Groups a plan's tasks into waves
 * of independent work (disjoint file scope, deps satisfied). Within a wave it
 * runs each task's sub-agent concurrently in its own git worktree, then a
 * synthesizer cherry-picks the per-task commits back onto the workspace HEAD
 * **serially** (the workspace index is shared, so merges must not race). Any
 * conflict, empty commit, or sub-agent error defers the task to the normal
 * sequential loop — fan-out never leaves the tree conflicted or half-merged.
 */

import type { AgentRuntimeId } from "./agent-runtime.js";
import { git, headSha } from "./git.js";
import type { TierLadder } from "./model-tier.js";
import { planParallelGroups, type PlanTask } from "./plan-tasks.js";
import type { StageResult } from "./runner.js";
import { executeStage } from "./stage-exec.js";
import { STAGES } from "./stages.js";
import { createWorktree } from "./worktree.js";

export type FanoutTaskStatus = "landed" | "deferred";

export type FanoutTaskOutcome = {
  task: PlanTask;
  status: FanoutTaskStatus;
  reason?: string;
};

export type FanoutResult = {
  outcomes: FanoutTaskOutcome[];
  /** Tasks that did not land cleanly and must be re-run sequentially. */
  deferred: PlanTask[];
};

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
   * The parallel per-task work: implement `task` inside `worktreeDir` and commit
   * there. Injectable so tests don't spawn a model; defaults to the
   * sub-implementer stage. A throw defers the task (its worktree is discarded).
   */
  runSubAgent?: (task: PlanTask, worktreeDir: string) => Promise<void>;
  /** Called with each default sub-agent's result so the loop rolls its cost +
   *  tokens into the run total (budget/pacing). Not called for an injected
   *  `runSubAgent`. */
  onSubAgent?: (sr: StageResult) => void;
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
};

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
      for (const task of wave) outcomes.push({ task, status: "deferred", reason: "aborted" });
      continue;
    }

    // Create one worktree per task up front (serial — git worktree add mutates
    // .git), then run the sub-agents concurrently inside them.
    const built: Built[] = wave.map((task) => {
      const wt = createWorktree(opts.workspaceDir, `${opts.iteration}-${task.id}`);
      return { task, dir: wt.dir, before: headSha(wt.dir), cleanup: wt.cleanup };
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

      // Phase B — serial cherry-pick onto the workspace HEAD.
      for (const b of built) {
        if (b.failure) {
          outcomes.push({ task: b.task, status: "deferred", reason: b.failure });
          continue;
        }
        const after = headSha(b.dir);
        if (!after || after === b.before) {
          outcomes.push({ task: b.task, status: "deferred", reason: "no commit produced" });
          continue;
        }
        const picked = git(
          ["cherry-pick", `${b.before}..${after}`],
          opts.workspaceDir
        );
        if (picked == null) {
          git(["cherry-pick", "--abort"], opts.workspaceDir);
          outcomes.push({ task: b.task, status: "deferred", reason: "cherry-pick conflict" });
          continue;
        }
        outcomes.push({ task: b.task, status: "landed" });
      }
    } finally {
      for (const b of built) b.cleanup();
    }
  }

  return {
    outcomes,
    deferred: outcomes.filter((o) => o.status === "deferred").map((o) => o.task),
  };
}
