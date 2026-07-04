import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentRuntimeId } from "./agent-runtime.js";
import type { ContextBreakdown } from "./context-report.js";
import type { VerificationEntry } from "./verification-matrix.js";
import type { PolicyViolationKind } from "./safety-policy.js";
import type { TaintSource } from "./taint.js";
import type { TokenUsage } from "./tokens.js";
import type {
  CbmIndexIdentity,
  IndexFreshness,
  WriteInventory,
} from "./codebase-memory-adapter.js";

/**
 * A safety-relevant occurrence recorded in a run's trajectory so policy
 * violations and untrusted-input handling are visible to evaluation scoring and
 * to a maintainer reading the bundle (issue #43 P4).
 *
 * Discriminated by `category`: a `policy-violation` carries the
 * {@link PolicyViolationKind} an evaluation predicate flagged; a `taint` event
 * records that an untrusted {@link TaintSource} was wrapped/surfaced. `blocked`
 * captures the issue's "blocked or reported" distinction — `true` when Otto
 * prevented the action, `false` when it only reported it (taint is always
 * reported, never blocked).
 *
 * INERT this slice: the type and the optional `safetyEvents` fields exist, but no
 * bin/loop populates them yet — the boundary checks that emit them land in a
 * later slice, so a recorded trajectory simply carries none today.
 */
export type SafetyEvent =
  | {
      category: "policy-violation";
      kind: PolicyViolationKind;
      subject: string;
      message: string;
      blocked: boolean;
    }
  | {
      category: "taint";
      kind: TaintSource;
      subject: string;
      message: string;
      blocked: boolean;
    };

/**
 * A skill applied during a run (issue #44 P5): which package/version, and why it
 * was selected (the retrieval reasons). Recorded into the trajectory so skill
 * usage shows up in run reports and benchmark comparisons.
 *
 * INERT this slice: the type and the optional `skillsUsed` fields exist, but no
 * bin/loop populates them yet — skills are surfaced read-only via `otto-skills`
 * and never auto-applied this PR. The field is ready for the future auto-use
 * slice; a recorded trajectory simply carries none today.
 */
export type SkillUsage = {
  /** The skill package name applied. */
  name: string;
  /** The skill version applied. */
  version: string;
  /** Source name an imported skill came from, or "repo" (issue #139 P18). */
  source?: string;
  /** Upstream ref of an imported skill, when pinned (issue #139 P18). */
  ref?: string;
  /** The stage that consumed the skill, when stage-scoped (issue #139 P18). */
  stage?: string;
  /** Why retrieval selected it (so a run report can explain the choice). */
  reasons?: string[];
};

/**
 * An external tool invoked during a run (issue #111 P19), parallel to
 * {@link SkillUsage}: which tool/kind, in which stage, and the levers the
 * evidence model needs — estimated tokens saved (for compressors), a retrieval
 * handle when the output is a reversible transform, and the selection reasons.
 *
 * INERT this slice: the type and the optional `toolsUsed` fields exist, but no
 * bin/loop populates them yet — tools are surfaced read-only via `otto-tools`
 * and never invoked by a stage this PR. The field is ready for the P20 Headroom
 * adapter; a recorded trajectory simply carries none today.
 */
export type ToolUsage = {
  /** The tool registry name invoked. */
  name: string;
  /** The tool's adapter kind (command/mcp/http/proxy/sdk). */
  kind: string;
  /** The stage that invoked it, when stage-scoped. */
  stage?: string;
  /** Estimated tokens saved by this invocation, if relevant. */
  tokensSaved?: number;
  /** Durable handle to retrieve reversible output, if any. */
  retrievalHandle?: string;
  /** Why the tool was selected/used (so a run report can explain the choice). */
  reasons?: string[];
  /** The tool's version, when known (P26 codebase-memory evidence). */
  toolVersion?: string;
  /** Identity of the index this invocation queried, when applicable (P26). */
  indexIdentity?: CbmIndexIdentity;
  /** Freshness classification of the index at invocation time (P26). */
  indexFreshness?: IndexFreshness;
  /** Estimated tokens avoided by retrieving via this tool instead of inline context (P26). */
  tokensAvoided?: number;
  /** Size of the result returned, if relevant (P26). */
  resultSize?: number;
  /** Wall-clock latency of the invocation in milliseconds (P26). */
  latencyMs?: number;
  /** The query issued to the tool, if applicable (P26). */
  query?: string;
  /** Reason the tool fell back to a degraded path, if it did (P26). */
  fallbackReason?: string;
};

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
  /** Safety events emitted while this stage ran (issue #43); absent = none. */
  safetyEvents?: SafetyEvent[];
  /** Skills applied while this stage ran (issue #44, INERT); absent = none. */
  skillsUsed?: SkillUsage[];
  /** External tools invoked while this stage ran (issue #111, INERT); absent = none. */
  toolsUsed?: ToolUsage[];
  /** Composition of this stage's rendered prompt (issue #62 P7); absent = not measured. */
  contextBreakdown?: ContextBreakdown;
  /** Finding severity counts from the review panel (P14); absent = not a panel stage. */
  reviewSeverity?: {
    blocker: number;
    major: number;
    minor: number;
    nit: number;
    suppressed: number;
  };
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
  /** Run-level safety events not tied to a single stage (issue #43); absent = none. */
  safetyEvents?: SafetyEvent[];
  /** Skills applied during the run (issue #44, INERT); absent = none. */
  skillsUsed?: SkillUsage[];
  /** External tools invoked during the run (issue #111, INERT); absent = none. */
  toolsUsed?: ToolUsage[];
  /** Input-sharpness assessment when `--sharpen-input` ran in `--plan` mode
   *  (issue #180 P23); absent when sharpening was off. The `unknowns` are the
   *  input dimensions the run had to assume rather than read from the input. */
  inputSharpness?: {
    metCount: number;
    maxScore: number;
    unknowns: string[];
  };
  /** Structured verification matrix from a `--verify` run (issue #181 P24);
   *  absent outside verify mode or when the stage emitted none. */
  verification?: VerificationEntry[];
  /** Count of malformed matrix rows the parser dropped on a `--verify` run
   *  (issue #181 review); absent/0 when the matrix was clean. */
  verificationDropped?: number;
  /** Run-level codebase-memory index record (P26 spike); absent for non-CBM runs. */
  codebaseMemory?: {
    indexIdentity?: CbmIndexIdentity;
    buildMs?: number;
    refreshMs?: number;
    writeInventory?: WriteInventory;
  };
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

/**
 * List the run ids present under `.otto/runs/`, sorted ascending. Because run
 * ids are lexicographically sortable (see {@link allocateRunId}), the last
 * entry is the most recent run — so "latest" is `at(-1)`. Absent/unreadable
 * dir → `[]` (never throws).
 */
export function listRunIds(workspaceDir: string): string[] {
  try {
    return readdirSync(runsDir(workspaceDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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

function reportPath(workspaceDir: string, runId: string): string {
  return join(runReportDir(workspaceDir, runId), "report.md");
}

/**
 * The H1 a quality report leads with — the content marker persistence keys on.
 */
export const REPORT_MARKER = "# Otto quality report";

/**
 * Does this stage result carry an emitted Otto quality report (P9 #64)?
 * Persistence keys on the report's H1 (content), not the stage name, because
 * which stage emits the report differs per run mode (the implementer in
 * ghafk/verify/apply-review; afk/plan-mode emits none).
 */
export function hasRunReport(stageResult: string): boolean {
  return stageResult.includes(REPORT_MARKER);
}

/**
 * Persist the layperson quality report a run emitted (P9 #64) to
 * `.otto/runs/<run-id>/report.md`, so `otto-explain` can re-render it later.
 * Best-effort — a bundle write must never break a run — so any failure is
 * swallowed (mirrors {@link removeStageRecords}).
 */
export function writeRunReport(
  workspaceDir: string,
  runId: string,
  text: string
): void {
  try {
    const p = reportPath(workspaceDir, runId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text.endsWith("\n") ? text : text + "\n");
  } catch {
    // Best-effort: never fail a run because the report could not be persisted.
  }
}

/** Read a run's persisted report. Absent/unreadable → null (never throws). */
export function readRunReport(
  workspaceDir: string,
  runId: string
): string | null {
  try {
    return readFileSync(reportPath(workspaceDir, runId), "utf8");
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
