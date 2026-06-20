/**
 * Sub-agent fan-out executor (issue #66 P11). Groups a plan's tasks into waves
 * of independent work (disjoint file scope, deps satisfied) and runs each task
 * concurrently in its own git worktree, then a synthesizer cherry-picks the
 * per-task commits back onto the workspace HEAD. Any conflict or post-merge
 * failure defers the task to the normal sequential loop — fan-out never leaves
 * the tree in a conflicted or half-merged state.
 */

import type { AgentRuntimeId } from "./agent-runtime.js";
import type { TierLadder } from "./model-tier.js";
import { planParallelGroups, type PlanTask } from "./plan-tasks.js";

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

/**
 * Run one task to completion (worktree → sub-agent → merge). Returns whether the
 * task's change landed cleanly. Injectable so tests never spawn a model; the
 * default (`defaultRunTask`, slice 7) does the real worktree + cherry-pick.
 */
export type RunTask = (
  task: PlanTask
) => Promise<{ ok: boolean; reason?: string }>;

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
  /** Override the per-task runner (tests inject a fake; default added in slice 7). */
  runTask?: RunTask;
};

/** Bounded-concurrency map: at most `limit` promises in flight at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/**
 * Run the plan's tasks wave-by-wave; collect landed/deferred outcomes. Within a
 * wave, tasks run concurrently up to `concurrency`. A wave whose tasks all defer
 * still proceeds to the next wave (the deferred ones flow back to the loop).
 */
export async function runFanout(opts: RunFanoutOptions): Promise<FanoutResult> {
  if (!opts.runTask) {
    throw new Error(
      "runFanout requires a runTask (defaultRunTask is wired in slice 7)"
    );
  }
  const runTask = opts.runTask;
  const waves = planParallelGroups(opts.tasks);
  const outcomes: FanoutTaskOutcome[] = [];
  for (const wave of waves) {
    if (opts.signal?.aborted) break;
    const waveOutcomes = await mapPool(wave, opts.concurrency, async (task) => {
      const r = await runTask(task);
      return {
        task,
        status: r.ok ? ("landed" as const) : ("deferred" as const),
        reason: r.reason,
      };
    });
    outcomes.push(...waveOutcomes);
  }
  return {
    outcomes,
    deferred: outcomes
      .filter((o) => o.status === "deferred")
      .map((o) => o.task),
  };
}
