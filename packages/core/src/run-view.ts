/**
 * Shared display model for P10 live execution visualization (issue #65).
 *
 * `RunView` is the pure data model built from a `RunManifest` + `StageRecord`s.
 * `buildRunView` constructs it; `formatDoneCard` and `formatLiveTree` render it.
 *
 * All TTY styling goes through `stream-render.ts` primitives so `NO_COLOR` /
 * non-TTY automatically degrades to clean ANSI-free lines.
 */

import type { PlanProgress } from "./plan-progress.js";
import type { RunManifest, StageRecord } from "./run-report.js";
import {
  bold,
  boldOut,
  dim,
  dimOut,
  green,
  greenOut,
  SYM,
  SYM_OUT,
} from "./stream-render.js";
import type { TokenUsage } from "./tokens.js";
import { formatTokenUsage } from "./tokens.js";
import { nextActionFor } from "./loop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single stage entry in the view's stage list. */
export type RunViewStage = {
  iteration: number;
  stage: string;
  isError: boolean;
};

/**
 * The shared view model that the done card, live console, and `otto-tail` all
 * render from — one source of truth built from the evidence bundle.
 */
export type RunView = {
  runId: string;
  bin: string;
  mode: string;
  /** "running" while the manifest has no `finishedAt`; "failed" for error exits; else "done". */
  status: "running" | "done" | "failed";
  /** Iterations completed so far (0 when un-finalized). */
  iterationsDone: number;
  /** Planned total iteration count for this run. */
  iterationsTotal: number;
  /** Cumulative USD cost from the manifest. */
  costUsd: number;
  /** Full token usage breakdown from the manifest. */
  tokenUsage: TokenUsage;
  /** Wall-clock duration in ms; null when un-finalized or timestamps unparseable, never NaN. */
  elapsedMs: number | null;
  /** Terminal exit reason string, or null while running. */
  exitReason: string | null;
  /** Maintainer-facing next-action hint, or null while running. */
  nextAction: string | null;
  /** Per-stage records in execution order. */
  stages: RunViewStage[];
  /** Plan-checklist progress when supplied by the caller; omitted otherwise. */
  planProgress?: PlanProgress;
  /** True when the bundle carries a review-followups artifact. */
  hasFollowups: boolean;
};

// ---------------------------------------------------------------------------
// Exit-reason classification
// ---------------------------------------------------------------------------

/** Exit reasons that map to "failed" status. Mirrors the failure notion in loop.ts. */
const FAILED_REASONS = new Set(["done with failures", "stopped (error)"]);

// ---------------------------------------------------------------------------
// buildRunView
// ---------------------------------------------------------------------------

/**
 * Build a `RunView` from a `RunManifest` and its stage records.
 * Pure: no I/O, no mutation, never throws.
 */
export function buildRunView(
  manifest: RunManifest,
  stages: StageRecord[],
  opts: { planProgress?: PlanProgress } = {}
): RunView {
  const running = manifest.finishedAt == null;
  const exitReason = manifest.exitReason ?? null;

  let status: "running" | "done" | "failed";
  if (running) {
    status = "running";
  } else if (exitReason != null && FAILED_REASONS.has(exitReason)) {
    status = "failed";
  } else {
    status = "done";
  }

  const elapsedMs = computeElapsedMs(manifest.startedAt, manifest.finishedAt);

  const hasFollowups = manifest.artifacts.some(
    (a) => a.kind === "review-followups"
  );

  const view: RunView = {
    runId: manifest.runId,
    bin: manifest.bin,
    mode: manifest.mode,
    status,
    iterationsDone: manifest.completedIterations ?? 0,
    iterationsTotal: manifest.iterations,
    costUsd: manifest.costUsd,
    tokenUsage: manifest.tokenUsage,
    elapsedMs,
    exitReason,
    nextAction: manifest.nextAction ?? null,
    stages: stages.map((s) => ({
      iteration: s.iteration,
      stage: s.stage,
      isError: s.isError,
    })),
    hasFollowups,
  };

  if (opts.planProgress !== undefined) {
    view.planProgress = opts.planProgress;
  }

  return view;
}

// ---------------------------------------------------------------------------
// elapsedMs helper — mirrors eval.ts discipline: null not NaN
// ---------------------------------------------------------------------------

function computeElapsedMs(
  startedAt: string,
  finishedAt?: string
): number | null {
  if (finishedAt == null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

// ---------------------------------------------------------------------------
// formatDoneCard
// ---------------------------------------------------------------------------

/**
 * Render the completion card for a finished run.
 *
 * FIRST LINE: `Otto <reason> · N iteration(s) · $<cost>` — the greppable
 * substring that `loop.test.ts` and any log-scraper key on. Must be preserved
 * verbatim (separator is ` · `, cost is `toFixed(2)`).
 */
export function formatDoneCard(view: RunView): string {
  const reason = view.exitReason ?? "done";
  const n = view.iterationsDone;
  const iters = `${n} iteration${n === 1 ? "" : "s"}`;
  const cost = `$${view.costUsd.toFixed(2)}`;

  // Greppable first line — same shape as loop.ts summarize().
  const firstLine =
    `${greenOut(SYM_OUT.bullet)} ${boldOut(`Otto ${reason}`)}` +
    `${dimOut(` · ${iters} · ${cost}`)}`;

  const lines: string[] = [firstLine];

  // Stage summary — what landed
  if (view.stages.length > 0) {
    const errorStages = view.stages.filter((s) => s.isError);
    if (errorStages.length > 0) {
      const names = errorStages.map((s) => s.stage).join(", ");
      lines.push(
        `${dimOut(`  ${SYM.cross} ${errorStages.length} stage error${errorStages.length === 1 ? "" : "s"}: ${names}`)}`
      );
    } else {
      const stageCount = view.stages.length;
      lines.push(
        `${dimOut(`  ${SYM.check} ${stageCount} stage${stageCount === 1 ? "" : "s"} completed`)}`
      );
    }
  }

  // Plan progress
  if (view.planProgress) {
    const { checked, total } = view.planProgress;
    lines.push(`${dimOut(`  plan: ${checked}/${total} tasks checked`)}`);
  }

  // Deferred follow-ups note
  if (view.hasFollowups) {
    lines.push(
      `${dimOut(`  follow-ups in .otto/review-followups.md — review before next run`)}`
    );
  }

  // Next-action hint
  const nextAction = view.nextAction ?? nextActionFor(reason);
  lines.push(`${dimOut(`  → next: ${nextAction}`)}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// formatLiveTree
// ---------------------------------------------------------------------------

/**
 * Render a glanceable live-tree view of an in-progress or completed run.
 * Shows a status header, iteration → stage tree, running cost/tokens/elapsed,
 * and plan progress when present.
 */
export function formatLiveTree(view: RunView): string {
  const lines: string[] = [];

  // Status header
  const statusLabel =
    view.status === "running"
      ? bold("running")
      : view.status === "failed"
        ? bold("failed")
        : green("done");

  const runtimeLabel = `${view.bin} · ${statusLabel}`;
  lines.push(
    `${dim("─")} ${runtimeLabel} ${dim(`[${view.runId}]`)}`
  );

  // Progress line: iterations + cost
  const iterLine = `iter ${view.iterationsDone}/${view.iterationsTotal}`;
  const costLine = `$${view.costUsd.toFixed(2)}`;
  const tokenLine = formatTokenUsage(view.tokenUsage);
  let metricsLine = `${dim(iterLine)}  ${dim(costLine)}  ${dim(tokenLine)}`;
  if (view.elapsedMs != null) {
    metricsLine += `  ${dim(formatElapsed(view.elapsedMs))}`;
  }
  lines.push(`  ${metricsLine}`);

  // Stage tree grouped by iteration
  if (view.stages.length > 0) {
    // Collect unique iterations in order
    const seenIter = new Set<number>();
    const iterStages = new Map<number, RunViewStage[]>();
    for (const s of view.stages) {
      if (!seenIter.has(s.iteration)) {
        seenIter.add(s.iteration);
        iterStages.set(s.iteration, []);
      }
      iterStages.get(s.iteration)!.push(s);
    }

    for (const [iter, stgs] of iterStages) {
      lines.push(`  ${dim(`iter ${iter}`)}`);
      for (const s of stgs) {
        const marker = s.isError
          ? dim(SYM.cross)
          : dim(SYM.check);
        lines.push(`    ${marker} ${s.isError ? bold(s.stage) : dim(s.stage)}`);
      }
    }
  }

  // Plan progress
  if (view.planProgress) {
    const { checked, total } = view.planProgress;
    const pct =
      total > 0 ? ` (${Math.round((checked / total) * 100)}%)` : "";
    lines.push(`  ${dim(`plan: ${checked}/${total} tasks${pct}`)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format elapsed milliseconds as a human-readable string. */
function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec > 0 ? `${sec}s` : ""}`;
}

