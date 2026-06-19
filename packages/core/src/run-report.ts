import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentRuntimeId } from "./agent-runtime.js";
import type { TokenUsage } from "./tokens.js";

/**
 * A named pointer to a file Otto produced during a run (rendered prompt, NDJSON
 * log, diff summary, …). Paths are workspace-relative so the bundle is portable.
 */
export type RunArtifact = {
  kind: string;
  path: string;
  description?: string;
};

/**
 * A normalized record of one stage execution (or review-panel substage),
 * derived from its {@link StageResult} plus the loop's per-stage context.
 */
export type StageRecord = {
  iteration: number;
  stage: string;
  runtimeId: AgentRuntimeId;
  costUsd: number;
  usage: TokenUsage;
  isError: boolean;
  apiErrorStatus: string | null;
  /** Workspace-relative NDJSON log path for this stage, when known. */
  logPath?: string;
  startedAt: string;
  finishedAt: string;
};

/**
 * The top-level evidence bundle for one Otto run, written to
 * `.otto/runs/<run-id>/manifest.json`. The per-stage records live alongside
 * under `stages/` — the directory is the list, so the manifest does not
 * duplicate it.
 */
export type RunManifest = {
  runId: string;
  bin: string;
  mode: string;
  inputs: string;
  runtime: { id: AgentRuntimeId; displayName: string };
  /** Branch strategy in effect (e.g. "branch" / "worktree" / "current"). */
  branchStrategy?: string;
  /** Planned iteration count for the run. */
  iterations: number;
  /** Iterations actually completed when the run ended. */
  completedIterations?: number;
  costUsd: number;
  tokenUsage: TokenUsage;
  /** Terminal exit reason (the string passed to the loop's `summarize`). */
  exitReason?: string;
  /** Maintainer-facing next-action hint for that exit reason. */
  nextAction?: string;
  artifacts: RunArtifact[];
  startedAt: string;
  finishedAt?: string;
};

/**
 * Allocate a sortable, filesystem-safe run id: an ISO timestamp with its
 * colons/periods replaced by dashes, suffixed by the pid to keep concurrent
 * runs on one host from colliding. Lexicographic order matches chronological
 * order, so "latest" is a plain string sort. `date`/`pid` are injectable so
 * tests are deterministic.
 */
export function allocateRunId(
  date: Date = new Date(),
  pid: number = process.pid
): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${pid}`;
}

const RUNS_REL = join(".otto", "runs");

/** Absolute path to the workspace's run-bundle root (`.otto/runs`). */
export function runsDir(workspaceDir: string): string {
  return join(workspaceDir, RUNS_REL);
}

/** Absolute path to one run's bundle dir (`.otto/runs/<run-id>`). */
export function runReportDir(workspaceDir: string, runId: string): string {
  return join(runsDir(workspaceDir), runId);
}

function manifestPath(workspaceDir: string, runId: string): string {
  return join(runReportDir(workspaceDir, runId), "manifest.json");
}

function stagesDir(workspaceDir: string, runId: string): string {
  return join(runReportDir(workspaceDir, runId), "stages");
}

/** Write the run manifest (creates `.otto/runs/<run-id>/`). */
export function writeManifest(
  workspaceDir: string,
  manifest: RunManifest
): void {
  const p = manifestPath(workspaceDir, manifest.runId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
}

/** Read a run manifest. Absent or malformed → null (never throws). */
export function readManifest(
  workspaceDir: string,
  runId: string
): RunManifest | null {
  try {
    return JSON.parse(
      readFileSync(manifestPath(workspaceDir, runId), "utf8")
    ) as RunManifest;
  } catch {
    return null;
  }
}

/**
 * Write one normalized stage record under the run's `stages/` dir. `seq` is a
 * monotonic per-run counter that zero-pads into the filename so records sort in
 * execution order. The stage segment is sanitized to `[A-Za-z0-9_-]` because
 * panel lens names (from `OTTO_REVIEW_LENSES`) are free text that becomes a
 * filename. Returns the written basename.
 */
export function writeStageRecord(
  workspaceDir: string,
  runId: string,
  seq: number,
  record: StageRecord
): string {
  const dir = stagesDir(workspaceDir, runId);
  mkdirSync(dir, { recursive: true });
  const safeStage = record.stage.replace(/[^A-Za-z0-9_-]/g, "-");
  const name = `${String(seq).padStart(4, "0")}-iter${record.iteration}-${safeStage}.json`;
  writeFileSync(join(dir, name), JSON.stringify(record, null, 2) + "\n");
  return name;
}

/**
 * Delete the named stage-record files (basenames from {@link writeStageRecord})
 * from a run's `stages/` dir. Used to roll back records written by a panel
 * attempt that later rate-limited and is being retried, so the bundle keeps one
 * record per stage rather than a duplicate per retry. Best-effort: a missing or
 * unremovable file is skipped (never throws).
 */
export function removeStageRecords(
  workspaceDir: string,
  runId: string,
  names: string[]
): void {
  const dir = stagesDir(workspaceDir, runId);
  for (const name of names) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Best-effort: never fail a run because a stale record could not be removed.
    }
  }
}

/**
 * Read every stage record for a run in execution (seq) order. Absent/unreadable
 * dir or a malformed entry → the records read so far (never throws); a malformed
 * file is skipped.
 */
export function readStageRecords(
  workspaceDir: string,
  runId: string
): StageRecord[] {
  let names: string[];
  try {
    names = readdirSync(stagesDir(workspaceDir, runId));
  } catch {
    return [];
  }
  const records: StageRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      records.push(
        JSON.parse(
          readFileSync(join(stagesDir(workspaceDir, runId), name), "utf8")
        ) as StageRecord
      );
    } catch {
      // Skip a malformed record rather than failing the whole read.
    }
  }
  return records;
}
