/**
 * Machine-readable plan task graph for sub-agent fan-out (issue #66 P11). The
 * plan stage (P8) writes `.otto/tasks/<task-key>/tasks.json` describing its tasks
 * as a dependency graph; the fan-out executor groups independent tasks into waves
 * and runs each in an isolated worktree. Parsing is throws-free: ANY invalid
 * input yields `[]`, so a bad/absent artifact silently disables fan-out and the
 * normal sequential loop runs (graceful degradation is mandatory).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One decomposed plan task. */
export type PlanTask = {
  id: string;
  title: string;
  /** Files this task is expected to touch — disjoint scopes can run in parallel. */
  fileScope: string[];
  /** Ids of tasks that must land before this one. */
  dependsOn: string[];
  /** False whenever the planner is unsure — forces a singleton (sequential) wave. */
  parallelSafe: boolean;
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validShape(t: unknown): t is PlanTask {
  const o = t as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.title === "string" &&
    isStringArray(o.fileScope) &&
    isStringArray(o.dependsOn) &&
    typeof o.parallelSafe === "boolean"
  );
}

/** True if the dependsOn graph has a cycle. */
function hasCycle(tasks: PlanTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=on-stack 2=done
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)!.dependsOn) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

/**
 * Parse + validate a tasks.json string. Returns `[]` on ANY problem (bad JSON,
 * shape, duplicate id, dangling dep, cycle) so fan-out degrades to the normal
 * loop — a bad plan artifact never aborts a run.
 */
export function parsePlanTasks(json: string): PlanTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const raw = (parsed as Record<string, unknown>)?.tasks;
  if (!Array.isArray(raw) || !raw.every(validShape)) return [];
  const tasks = raw as PlanTask[];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) return [];
    ids.add(t.id);
  }
  for (const t of tasks) {
    if (t.dependsOn.some((d) => !ids.has(d))) return [];
  }
  if (hasCycle(tasks)) return [];
  return tasks;
}

/** Read + parse `.otto/tasks/<taskKey>/tasks.json`; `[]` when absent/invalid. */
export function readPlanTasks(workspaceDir: string, taskKey: string): PlanTask[] {
  try {
    const txt = readFileSync(
      join(workspaceDir, ".otto", "tasks", taskKey, "tasks.json"),
      "utf8"
    );
    return parsePlanTasks(txt);
  } catch {
    return [];
  }
}

/**
 * Discover a plan task graph without knowing the task-key (the plan agent picks
 * the slug itself). Scans `.otto/tasks/<key>/tasks.json`, parses each, and
 * returns the tasks from the most-recently-modified valid, non-empty file — the
 * one most likely to belong to the current work. `[]` when none qualify, so
 * fan-out simply disables.
 */
export function discoverPlanTasks(workspaceDir: string): PlanTask[] {
  const tasksDir = join(workspaceDir, ".otto", "tasks");
  let dirs: string[];
  try {
    dirs = readdirSync(tasksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  let best: { tasks: PlanTask[]; mtimeMs: number } | undefined;
  for (const key of dirs) {
    const file = join(tasksDir, key, "tasks.json");
    let txt: string;
    let mtimeMs: number;
    try {
      txt = readFileSync(file, "utf8");
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const tasks = parsePlanTasks(txt);
    if (tasks.length === 0) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { tasks, mtimeMs };
  }
  return best?.tasks ?? [];
}

/**
 * Group tasks into execution waves. A task joins the current wave iff all its
 * deps are in earlier waves, it is `parallelSafe`, and its `fileScope` is
 * disjoint from every task already in the wave. A non-`parallelSafe` task (or
 * one whose scope overlaps the wave) runs alone in its own wave, preserving
 * correctness. Assumes a validated (acyclic) graph from {@link parsePlanTasks}.
 */
export function planParallelGroups(tasks: PlanTask[]): PlanTask[][] {
  const waves: PlanTask[][] = [];
  const done = new Set<string>();
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const wave: PlanTask[] = [];
    const usedScope = new Set<string>();
    for (const t of remaining) {
      const depsReady = t.dependsOn.every((d) => done.has(d));
      if (!depsReady) continue;
      const disjoint = t.fileScope.every((f) => !usedScope.has(f));
      if (wave.length === 0) {
        // First task in the wave always admitted (deps ready). A non-parallel
        // task seals the wave as a singleton.
        wave.push(t);
        t.fileScope.forEach((f) => usedScope.add(f));
        if (!t.parallelSafe) break;
      } else if (t.parallelSafe && disjoint) {
        wave.push(t);
        t.fileScope.forEach((f) => usedScope.add(f));
      }
    }
    if (wave.length === 0) {
      // Deadlock guard (unreachable on a validated graph): drop the head as a
      // singleton so the loop always terminates.
      wave.push(remaining[0]);
    }
    for (const t of wave) done.add(t.id);
    const ids = new Set(wave.map((t) => t.id));
    remaining = remaining.filter((t) => !ids.has(t.id));
    waves.push(wave);
  }
  return waves;
}
