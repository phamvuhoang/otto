import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { AGENT_DISPLAY_NAMES, type AgentRuntimeId } from "./agent-runtime.js";
import { readCoreVersion } from "./cli-help.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { changedFilesSince, headSha } from "./git.js";
import { sleep, isThrottle, nextCooldownFactor } from "./pacing.js";
import { decide } from "./policy.js";
import { deriveProgress, type IterationObservation } from "./progress.js";
import {
  classifyRisk,
  explainRouting as formatRouting,
  routeReview,
} from "./risk.js";
import { resolveTierLadder, type TierLadder } from "./model-tier.js";
import { discoverPlanTasks } from "./plan-tasks.js";
import { reviewsFanoutInsteadOfReplan } from "./plan-fanout.js";
import {
  formatInputSharpness,
  formatSharpeningGuidance,
  scoreInputSharpness,
} from "./input-sharpness.js";
import {
  parseVerificationMatrixWithDiagnostics,
  type VerificationEntry,
} from "./verification-matrix.js";
import { runFanout } from "./fanout.js";
import { reapWorktrees } from "./worktree.js";
import { RateLimitError, computeWaitMs } from "./rate-limit.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import { cleanScratch } from "./scratch.js";
import { getAgentRuntime, stageLogPath, type StageResult } from "./runner.js";
import {
  runRetrievalStore,
  type CompressorMode,
  type RetrievalStore,
  type SyncContextCompressor,
} from "./context-compressor.js";
import { createHeadroomSyncCompressor } from "./headroom-adapter.js";
import {
  allocateRunId,
  hasRunReport,
  readStageRecords,
  removeStageRecords,
  runReportDir,
  writeManifest,
  writeRunReport,
  writeStageRecord,
  type RunArtifact,
  type RunManifest,
  type SkillUsage,
  type StageRecord,
} from "./run-report.js";
import {
  DEFAULT_REPORT_LEGIBILITY_THRESHOLD,
  extractRunReport,
  finalizeReportText,
} from "./report-finalize.js";
import { scoreReportLegibility } from "./report-rubric.js";
import { stageEnabled, type SkillActivation } from "./skill-activation.js";
import {
  formatSkillInjection,
  routeSkillsForStage,
  stageFamily,
  toSkillUsages,
} from "./skill-routing.js";
import { readSkills, type Skill } from "./skills.js";
import { executeStage } from "./stage-exec.js";
import { ConsoleUi, VerboseSink, type EventSink } from "./console-ui.js";
import {
  clearState,
  matchesResume,
  readState,
  writeState,
  type RunState,
} from "./state.js";
import {
  USE_COLOR,
  dim,
  bold,
  red,
  greenOut,
  boldOut,
  dimOut,
  SYM,
  SYM_OUT,
} from "./stream-render.js";
import type { Stage } from "./stages.js";
import { maybeJournal } from "./journal.js";
import {
  detectScopeDrift,
  formatPlanDepthRubric,
  scorePlanDepth,
  scorePlanQuality,
} from "./plan-rubric.js";
import { assessPlanGate, formatPlanGate } from "./plan-gate.js";
import { latestTaskPlanDocument } from "./plan-artifacts.js";
import {
  formatCheckpointPrompt,
  resolvePlanCheckpoint,
} from "./plan-checkpoint.js";
import {
  addTokenUsage,
  emptyTokenUsage,
  formatTokenUsage,
  type TokenMode,
  type TokenUsage,
} from "./tokens.js";
import { buildRunView, formatDoneCard } from "./run-view.js";
import { nextActionFor } from "./next-action.js";
export { nextActionFor };

// The agent emits this literal when there is no more work; the same string is
// mirrored in the playbook templates (prompt.md / ghprompt.md) that instruct it.
const SENTINEL = "<promise>NO MORE TASKS</promise>";

// Bounded one-shot report-rewrite stage (P15 #85). Invoked directly outside the
// main chain when an emitted quality report fails the emit-time legibility
// rubric, mirroring panel.ts's locally-defined stage consts. Latched to one
// rewrite per run via reportRewriteUsed.
const REPORT_REWRITE_STAGE: Stage = {
  name: "report-rewrite",
  template: "report-rewrite.md",
  permissionMode: "bypassPermissions",
  tier: "mid",
};

const RATE_LIMIT_BUFFER_MS = 30_000;
// Interactive plan checkpoint grace period: an AFK run can hold a TTY but have no
// human, so auto-approve (record the assumption) rather than block forever.
const PLAN_CHECKPOINT_TIMEOUT_MS = 2 * 60_000;
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 6 * 3600_000;

// Counts *open* deferred findings recorded in `.otto/review-followups.md` by
// tallying top-level Markdown bullets (lines starting with "- ", no leading
// indent). The file is append-only across review sessions and never prunes, so
// a bullet whose block is marked FIXED/RESOLVED (on the bullet line or any of
// its indented continuation lines) is excluded — otherwise the count measures
// file age, not outstanding work. Headings, prose, blank lines, the lazy
// placeholder, and nested detail bullets are ignored. Lines inside a fenced
// code block (```…```) are skipped entirely, so a quoted diff or left-margin
// list in a finding's detail neither inflates the count nor ends the enclosing
// bullet. Pure + exported so it is unit-testable without a workspace.
export function countDeferredFollowups(text: string): number {
  const resolved = /\b(FIXED|RESOLVED)\b/;
  let n = 0;
  let open = false; // currently inside a top-level bullet not yet seen resolved
  let inFence = false; // inside a ``` fenced code block — its lines never count
  const flush = () => {
    if (open) n++;
    open = false;
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // fence delimiter: toggle, never a bullet/heading
      continue;
    }
    if (inFence) continue; // code content neither counts nor ends a bullet
    if (/^- /.test(line)) {
      flush(); // close the previous bullet
      open = !resolved.test(line);
    } else if (/^\s/.test(line)) {
      if (open && resolved.test(line)) open = false; // continuation marks it done
    } else {
      flush(); // heading/prose/blank at col 0 ends the current bullet
    }
  }
  flush();
  return n;
}

/**
 * Copy a `--verify` run's captured screenshots out of `.otto-tmp/` into the run
 * bundle (`.otto/runs/<run-id>/verification/`) and rewrite each `visual` entry's
 * path to be **report-relative**, so the screenshot links in the persisted
 * report/manifest resolve and the images are preserved as run artifacts (#181
 * review). Non-file references (`file:line`, SHAs) and missing files are left
 * untouched. Best-effort: a copy that fails leaves the original path. Pure-ish
 * (fs side effects only into the bundle).
 */
function relocateVerificationScreenshots(
  entries: VerificationEntry[],
  workspaceDir: string,
  runId: string
): VerificationEntry[] {
  const destDir = join(runReportDir(workspaceDir, runId), "verification");
  const relocate = (
    p: string | undefined,
    label: string,
    idx: number
  ): string | undefined => {
    if (!p) return p;
    const abs = isAbsolute(p) ? p : join(workspaceDir, p);
    if (!existsSync(abs)) return p; // a reference (file:line / SHA) or already gone
    try {
      mkdirSync(destDir, { recursive: true });
      const safe = `${idx}-${label}-${basename(p)}`
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 100);
      copyFileSync(abs, join(destDir, safe));
      return `verification/${safe}`; // relative to report.md / manifest.json in the bundle
    } catch {
      return p; // best-effort: never fail finalize over a screenshot copy
    }
  };
  return entries.map((e, idx) => {
    if (e.method !== "visual") return e;
    const next = { ...e };
    const after = relocate(e.artifactPath, "after", idx);
    if (after !== undefined) next.artifactPath = after;
    const before = relocate(e.beforePath, "before", idx);
    if (before !== undefined) next.beforePath = before;
    return next;
  });
}

function deferredFollowupCount(workspaceDir: string): number {
  try {
    return countDeferredFollowups(
      readFileSync(join(workspaceDir, ".otto", "review-followups.md"), "utf8")
    );
  } catch {
    return 0; // absent/unreadable trail → nothing deferred to surface.
  }
}

export type LoopOptions = {
  // First stage is the gate: its result is checked for the completion sentinel.
  // Subsequent stages always run after a non-sentinel gate result.
  stages: [Stage, ...Stage[]];
  /** Reviewer stage run over the aggregated fan-out diff when a `--plan` run's
   *  fan-out lands implementation work (issue #177). Without it, a `--plan` +
   *  `--fan-out` run falls back to re-authoring the plan. Only otto-afk sets it. */
  reviewStage?: Stage;
  inputs: string;
  iterations: number;
  /** Host repo Claude runs against (cwd). */
  workspaceDir: string;
  /** Installed @phamvuhoang/otto-core dir; stage templates are read from <packageDir>/templates. */
  packageDir: string;
  /** When true, skip OS wake-lock acquisition. Default: false. */
  noKeepAlive?: boolean;
  /** Per-stage retry budget. Default: 3. Set to 0 to disable retries. */
  maxRetries?: number;
  /** When true, fire OS notification + bell on loop terminal events. Default: false. */
  notify?: boolean;
  /** Bin name for the init-time version banner (e.g. "otto-afk"). */
  bin?: string;
  /** CLI version for the init-time version banner. */
  cliVersion?: string;
  /** Stop the loop when cumulative stage cost reaches this USD ceiling. */
  budgetUsd?: number;
  /** Milliseconds to wait between iterations. 0 = no cooldown. */
  cooldownMs?: number;
  /** Token accounting/reduction mode. Default: off. */
  tokenMode?: TokenMode;
  /** Opt-in reviewer panel: replace the single reviewer stage with K read-only lens reviewers + one synth commit. */
  reviewLenses?: string[];
  /** Opt-in adaptive compute router (issue #41): route review depth per iteration
   *  by the risk of that iteration's change. When off, `reviewLenses` is used as-is. */
  adaptiveRouter?: boolean;
  /** Opt-in (issue #45 P6): print the adaptive router's per-iteration reasoning
   *  (change class/risk, chosen depth/lenses, policy decision). No effect when
   *  `adaptiveRouter` is off — there is no routing decision to explain. */
  explainRouting?: boolean;
  /** Injectable resolver for an iteration's changed paths (default: git diff since
   *  the iteration-start HEAD). Used only when `adaptiveRouter` is on. */
  resolveChangedPaths?: (workspaceDir: string) => string[];
  /** Opt-in per-stage model routing (issue #66 P11): route each stage to a model
   *  tier by difficulty + change risk, escalating on repeated failure. A pinned
   *  model overrides it. When off, every stage uses the runtime default model. */
  modelRouting?: boolean;
  /** tier → model ladder consulted when `modelRouting` resolves a tier. */
  tierLadder?: TierLadder;
  /** Opt-in input sharpening (issue #180 P23): in `--plan` mode, score the run's
   *  input and, when it omits dimensions (goal/constraints/success criteria/…),
   *  inject a bounded sharpening-guidance block into the plan stage so the author
   *  records an explicit assumption per gap. Off/undefined or a sharp input ⇒
   *  nothing injected and the plan prompt is byte-identical. */
  sharpenInput?: boolean;
  /** Opt-in runtime skill activation (issue #114 P18): inject validated,
   *  stage-scoped skill guidance into live stages. When off/undefined, no skill
   *  is selected or injected and the run is byte-for-byte unchanged. */
  skillActivation?: SkillActivation;
  /** Opt-in sub-agent fan-out (issue #66 P11): on the first iteration, run the
   *  independent tasks of a `.otto/tasks/<key>/tasks.json` as isolated worktree
   *  sub-agents before the sequential loop. No valid tasks.json → no-op. */
  fanOut?: boolean;
  /** Max concurrent sub-agents per fan-out wave (default 3). */
  fanOutConcurrency?: number;
  /** Injected AbortSignal for daemon callers (e.g. watch mode). When provided,
   *  runLoop skips wake-lock acquisition and process signal handler installation;
   *  the caller owns both. */
  signal?: AbortSignal;
  /** Run mode for state.json identity (e.g. "afk" / "ghafk"). Default "afk". */
  mode?: string;
  /** Branch strategy in effect (e.g. "branch" / "worktree" / "current"),
   *  recorded in the run manifest. */
  branchStrategy?: string;
  /** Cap on the rate-limit wait before halting. Default 6h. */
  maxWaitMs?: number;
  /** Force a fresh run, ignoring/clearing prior state. Default false. */
  fresh?: boolean;
  /** Active agent runtime id. Default "claude". Labels log files + the summary line. */
  agentId?: AgentRuntimeId;
  /** Active runtime display name (e.g. "Claude Code"). Default "Claude Code". Shown in the run + stage banners. */
  agentDisplayName?: string;
  /** Fallback runtime to switch to when the active runtime hits a usage/rate
   *  limit. Undefined = no fallback configured (switching is off). */
  fallbackAgentId?: AgentRuntimeId;
  /** Display name for the fallback runtime; defaults from AGENT_DISPLAY_NAMES. */
  fallbackAgentDisplayName?: string;
  /** Switch to the fallback runtime on a limit instead of waiting for the reset.
   *  Default false — switching providers changes model behavior, so it is opt-in. */
  autoSwitchOnLimit?: boolean;
  /** Restore the full in-run firehose (issue #65 P10). Default false → the quiet
   *  ConsoleUi renders one terse line per meaningful action. The `--verbose` CLI
   *  flag that sets this is wired in a later slice. */
  verbose?: boolean;
  /** Opt-in context compressor (issue #112 P20). "headroom" routes @spill output
   *  through the Headroom adapter (reversible, measured); "off" (default) leaves
   *  spill output verbatim. A requested-but-unavailable compressor warns once and
   *  continues uncompressed — never a broken run. */
  contextCompressor?: CompressorMode;
};

export type LoopOutcome = {
  costUsd: number;
  sentinelHit: boolean;
  tokenUsage: TokenUsage;
};

type KeyboardControls = {
  pauseIfRequested: () => Promise<void>;
  cleanup: () => void;
};

function installKeyboardControls(opts: {
  enabled: boolean;
  quit: () => void;
}): KeyboardControls {
  const noopControls: KeyboardControls = {
    pauseIfRequested: async () => {},
    cleanup: () => {},
  };
  const input = process.stdin;
  const canUseTty =
    opts.enabled &&
    Boolean(input.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    Boolean(process.stderr.isTTY) &&
    typeof input.setRawMode === "function";
  if (!canUseTty) return noopControls;

  let pauseRequested = false;
  let paused = false;
  let resumePaused: (() => void) | undefined;
  let cleaned = false;
  let wasRaw = false;
  try {
    wasRaw = Boolean(input.isRaw);
  } catch {
    wasRaw = false;
  }

  const resume = (): void => {
    if (!paused) return;
    paused = false;
    const resolve = resumePaused;
    resumePaused = undefined;
    process.stderr.write("resuming\n");
    resolve?.();
  };

  const onData = (chunk: Buffer | string): void => {
    for (const key of String(chunk)) {
      if (key === "p") {
        pauseRequested = true;
      } else if (key === "r") {
        resume();
      } else if (key === "q" || key === "\u0003") {
        opts.quit();
      }
    }
  };

  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  process.stderr.write(
    "controls: [p] pause after current stage · [r] resume · [q] quit (save state & exit)\n"
  );

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    input.off("data", onData);
    input.setRawMode?.(wasRaw);
    input.pause();
  };

  return {
    pauseIfRequested: async () => {
      if (!pauseRequested) return;
      pauseRequested = false;
      paused = true;
      process.stderr.write("paused — press r to resume\n");
      await new Promise<void>((resolve) => {
        resumePaused = resolve;
      });
    },
    cleanup,
  };
}

export async function runLoop(opts: LoopOptions): Promise<LoopOutcome> {
  const {
    stages,
    reviewStage,
    inputs,
    iterations,
    workspaceDir,
    packageDir,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    notify = false,
    bin = "otto",
    cliVersion = "?",
    budgetUsd,
    cooldownMs = 0,
    tokenMode = "off",
    reviewLenses,
    adaptiveRouter = false,
    explainRouting = false,
    modelRouting = false,
    tierLadder,
    skillActivation,
    sharpenInput = false,
    fanOut = false,
    fanOutConcurrency = 3,
    resolveChangedPaths,
    signal: externalSignal,
    mode = "afk",
    branchStrategy,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    fresh = false,
    agentId = "claude",
    agentDisplayName = "Claude Code",
    fallbackAgentId,
    fallbackAgentDisplayName,
    autoSwitchOnLimit = false,
    verbose = false,
    contextCompressor = "off",
  } = opts;

  // Input sharpening (issue #180 P23): in --plan mode, score the run's input once.
  // The score drives the bounded `{{ SHARPENING }}` guidance injected into the
  // plan stage and is recorded on the manifest as evidence (the gaps the run had
  // to assume). Null when off or not planning ⇒ the plan prompt is byte-identical
  // and the manifest carries no sharpness block.
  const inputSharpness =
    sharpenInput && mode === "plan" ? scoreInputSharpness(inputs) : null;
  const sharpeningGuidance = inputSharpness
    ? formatSharpeningGuidance(inputSharpness)
    : "";

  // One in-run console sink per run (issue #65 P10): quiet ConsoleUi by default,
  // the full firehose under --verbose. Threaded into every stage via executeStage.
  const sink: EventSink = verbose ? new VerboseSink() : new ConsoleUi();

  // The runtime in effect right now. Starts at the resolved primary and is
  // reassigned in place when auto-switch fires on a limit, so every downstream
  // seam (stage banner, executeStage/panel agentId, log path, state, summary)
  // tracks the live runtime rather than the initially-selected one.
  let activeAgentId: AgentRuntimeId = agentId;
  let activeAgentDisplayName = agentDisplayName;
  const fallbackDisplayName =
    fallbackAgentDisplayName ??
    (fallbackAgentId ? AGENT_DISPLAY_NAMES[fallbackAgentId] : undefined);
  // True once we have switched off the primary; `switchFromId` is the primary we
  // came from, so the summary can report `primary -> fallback`.
  let switched = false;
  const switchFromId: AgentRuntimeId = agentId;

  const nowIso = () => new Date().toISOString();
  const runStartSha = headSha(workspaceDir);
  // Verification matrix (issue #181 P24): the verify stage writes this gitignored
  // scratch file; finalize reads it back. Clear any stale matrix from a prior
  // verify run at start so a run whose agent emits none can't inherit one.
  const verifyMatrixPath = join(
    workspaceDir,
    ".otto-tmp",
    "verify-matrix.json"
  );
  if (mode === "verify") {
    try {
      rmSync(verifyMatrixPath, { force: true });
    } catch {
      // best-effort: a leftover scratch file must never block the run.
    }
  }
  if (fresh) clearState(workspaceDir);
  const prior = fresh ? null : readState(workspaceDir);
  const resuming = matchesResume(prior, { bin, mode, inputs });
  const startIteration = resuming ? prior!.iteration : 1;
  const total = resuming ? prior!.of : iterations;
  let resumeNote = "";

  // Resume keeps the fallback: if the prior run had switched runtimes, restore
  // it before printing the run banner so the first visible runtime matches the
  // runtime the resumed paid stage will actually use. `--fresh` clears state, so
  // a fresh run always starts on the primary.
  if (resuming && prior!.agent && prior!.agent !== agentId) {
    activeAgentId = prior!.agent;
    activeAgentDisplayName = AGENT_DISPLAY_NAMES[prior!.agent];
    switched = true;
  }

  const versionLine = `${bin} ${cliVersion} (core ${readCoreVersion()}) · runtime: ${activeAgentDisplayName}`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );
  // --explain-routing only has decisions to explain when the router is on; say so
  // once rather than silently no-op the flag (issue #45 operator clarity).
  if (explainRouting && !adaptiveRouter && !modelRouting) {
    process.stderr.write(
      `${dim("note: --explain-routing has no effect without --adaptive-router or --model-routing")}\n`
    );
  }

  // Allocate the run id and write an initial evidence-bundle manifest at loop
  // start, so a run that crashes before any terminal path still leaves a record
  // of what it was about to do. Later tasks finalize this manifest (cost/token
  // totals, exit reason, artifacts) and write per-stage records alongside.
  const runId = allocateRunId();
  const manifestStartedAt = nowIso();
  writeManifest(workspaceDir, {
    runId,
    bin,
    mode,
    inputs,
    runtime: { id: activeAgentId, displayName: activeAgentDisplayName },
    branchStrategy,
    iterations: total,
    costUsd: 0,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    startedAt: manifestStartedAt,
  });

  // Context compressor (issue #112 P20): built once per run, off by default.
  // A requested-but-unavailable compressor warns once here and continues
  // uncompressed (degrade clean) rather than failing the run or emitting a
  // degraded record at every spill.
  const compressorMode: CompressorMode = contextCompressor;
  let compressor: SyncContextCompressor | null =
    compressorMode === "headroom" ? createHeadroomSyncCompressor() : null;
  if (compressor && !compressor.available) {
    process.stderr.write(
      `${dim("note: --context-compressor headroom requested but `headroom` is unavailable — continuing without compression")}\n`
    );
    compressor = null;
  }
  const retrievalStore: RetrievalStore = runRetrievalStore(workspaceDir, runId);

  // Per-stage evidence records: `stageSeq` is a monotonic counter that orders
  // them under the bundle's `stages/` dir. Recording is best-effort — a bundle
  // write must never break the run. The panel records its own substages via the
  // same closure (threaded as `recordStage`), so lens/verify/synth each get a
  // record named for the substage rather than one umbrella "reviewer" record.
  // Basenames of the records written so far, in seq order — the array length is
  // the next seq, so records stay contiguous, and a failed panel attempt's
  // records can be rolled back by truncating + deleting (see the retry catch).
  const recordedStageFiles: string[] = [];
  // Lightweight in-memory log mirroring recordedStageFiles; used by summarize
  // to build a RunView for formatDoneCard without a disk round-trip.
  const stageLog: { iteration: number; stage: string; isError: boolean }[] = [];
  const recordStage = (
    recIteration: number,
    stageName: string,
    sr: StageResult,
    startedAt: string,
    reviewSeverity?: {
      blocker: number;
      major: number;
      minor: number;
      nit: number;
      suppressed: number;
    }
  ): void => {
    stageLog.push({
      iteration: recIteration,
      stage: stageName,
      isError: sr.isError,
    });
    try {
      const name = writeStageRecord(
        workspaceDir,
        runId,
        recordedStageFiles.length,
        {
          iteration: recIteration,
          stage: stageName,
          runtimeId: sr.runtimeId ?? activeAgentId,
          costUsd: sr.costUsd,
          usage: sr.usage,
          isError: sr.isError,
          apiErrorStatus: sr.apiErrorStatus,
          logPath: sr.logPath,
          safetyEvents: sr.safetyEvents,
          contextBreakdown: sr.contextBreakdown,
          ...(sr.toolsUsed ? { toolsUsed: sr.toolsUsed } : {}),
          ...(sr.skillsUsed ? { skillsUsed: sr.skillsUsed } : {}),
          ...(reviewSeverity ? { reviewSeverity } : {}),
          startedAt,
          finishedAt: nowIso(),
        }
      );
      recordedStageFiles.push(name);
    } catch {
      // Best-effort: never fail a run because a stage record could not be written.
    }
  };

  // Runtime skill activation (issue #114 P18). Off by default: when activation is
  // disabled, `injectSkills` short-circuits to an empty block + no evidence, so a
  // non-opted-in run renders exactly as before. The installed skills are read once,
  // lazily, only when a run actually activates them.
  const skillsActive = skillActivation?.enabled === true;
  let installedSkills: Skill[] | null = null;
  /** All skills injected across the run, aggregated onto the manifest. */
  const runSkillsUsed: SkillUsage[] = [];
  const injectSkills = (
    stageName: string,
    changedPaths: string[]
  ): { block: string; usages: SkillUsage[] } => {
    if (!skillsActive) return { block: "", usages: [] };
    const family = stageFamily(stageName);
    if (!family || !stageEnabled(skillActivation!, family)) {
      return { block: "", usages: [] };
    }
    if (installedSkills === null) installedSkills = readSkills(workspaceDir);
    const route = routeSkillsForStage(installedSkills, {
      stageName,
      changedPaths,
    });
    return {
      block: formatSkillInjection(route.selected),
      usages: toSkillUsages(route.selected, stageName),
    };
  };

  // When an external signal is injected (daemon/watch mode), the caller owns
  // wake-lock + process signal handlers. Skip both here.
  const releaser: Releaser =
    externalSignal || noKeepAlive
      ? { release: () => {} }
      : acquire({ reason: `${bin} loop` });
  const stageAbort = externalSignal ? undefined : new AbortController();
  const activeSignal = externalSignal ?? stageAbort!.signal;

  // Single release path: signal handlers and the finally below all funnel
  // through releaseOnce so the wake-lock child is killed exactly once.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };

  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  let keyboardControls: KeyboardControls | undefined;
  const gracefulExit = (code: 130 | 143, message: string): never => {
    if (!externalSignal && !stageAbort!.signal.aborted) stageAbort!.abort();
    if (notify) notifyError(message);
    keyboardControls?.cleanup();
    releaseOnce();
    cleanScratch(workspaceDir);
    process.exit(code);
  };
  if (!externalSignal) {
    // process.exit() pre-empts the per-stage `finally` scratch cleanup, so the
    // interrupt path sweeps ephemeral .otto-tmp artifacts synchronously here.
    onSigint = (): void => {
      gracefulExit(130, "interrupted (SIGINT)");
    };
    onSigterm = (): void => {
      gracefulExit(143, "terminated (SIGTERM)");
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }
  keyboardControls = installKeyboardControls({
    enabled: !externalSignal,
    quit: () => gracefulExit(130, "interrupted (keyboard quit)"),
  });

  let completedIterations = 0;
  let sentinelHit = false;
  // Most recent emitted quality report, kept so finalize can enrich + persist it
  // to the bundle for `otto-explain`. Captured by content marker; null until a
  // stage emits one; when absent, finalize falls back to a harness-authored
  // evidence-first report.
  let lastReportText: string | null = null;
  let planReplanUsed = false;
  let reportRewriteUsed = false;
  let runCostUsd = 0;
  let runTokenUsage = emptyTokenUsage();
  let cooldownFactor = 1;
  // Model-routing escalation (issue #66 P11): count consecutive iterations whose
  // gate stage (the implementer) returned an error, then escalate the routed tier
  // by `streak - 1` — the current tier gets one retry before the first bump, and
  // a persistently wedged run climbs toward the strong tier (capped in routeModel).
  let gateFailureStreak = 0;
  let modelEscalations = 0;
  const outcome = (): LoopOutcome => ({
    costUsd: runCostUsd,
    sentinelHit,
    tokenUsage: runTokenUsage,
  });

  // Single source of truth for per-stage accounting: tally cost, report it,
  // advance the adaptive cooldown factor on throttle, and report whether the
  // budget is now exhausted. Used once per non-panel stage AND once per panel
  // sub-agent (passed to runPanel as onStage), so budget + adaptive pacing
  // apply uniformly to lenses, synth, and ordinary stages alike.
  const accountStage = (
    sr: StageResult
  ): { stop: boolean; cooldownFactor: number } => {
    runCostUsd += sr.costUsd;
    runTokenUsage = addTokenUsage(runTokenUsage, sr.usage);
    process.stderr.write(
      `${dim(`· $${sr.costUsd.toFixed(2)} (run $${runCostUsd.toFixed(2)})`)}\n`
    );
    if (tokenMode !== "off") {
      process.stderr.write(
        `${dim(`tokens ${formatTokenUsage(sr.usage)} | run ${formatTokenUsage(runTokenUsage)}`)}\n`
      );
    }
    cooldownFactor = nextCooldownFactor(
      cooldownFactor,
      isThrottle(sr.apiErrorStatus)
    );
    return {
      stop: budgetUsd != null && runCostUsd >= budgetUsd,
      cooldownFactor,
    };
  };

  // Artifact links a finalized manifest carries. The raw NDJSON logs dir is
  // always present (success metric: raw `.otto-tmp/logs` debugging stays
  // available); the deferred-followups trail is linked only when it exists.
  // Paths are workspace-relative so the bundle is portable.
  const collectArtifacts = (): RunArtifact[] => {
    const list: RunArtifact[] = [
      {
        kind: "ndjson-logs",
        path: join(".otto-tmp", "logs"),
        description: "raw per-stage NDJSON run logs",
      },
    ];
    if (existsSync(join(workspaceDir, ".otto", "review-followups.md"))) {
      list.push({
        kind: "review-followups",
        path: join(".otto", "review-followups.md"),
        description: "deferred reviewer follow-ups",
      });
    }
    // The persisted plain-language report (P9 #64), linked only when a stage
    // emitted one and finalize wrote it (see finalizeManifest below).
    if (existsSync(join(workspaceDir, ".otto", "runs", runId, "report.md"))) {
      list.push({
        kind: "report",
        path: join(".otto", "runs", runId, "report.md"),
        description: "plain-language run report (otto-explain)",
      });
    }
    return list;
  };

  // Finalize the run manifest on a terminal exit: stamp the completed-iteration
  // count, cumulative cost/token totals, the exit reason + its next-action hint,
  // the active runtime, artifact links, and finishedAt. Best-effort — a bundle
  // write must NEVER break a run (mirrors the initial write + recordStage).
  // Called once per terminal path through `summarize`, so every exit reason is
  // covered without threading the manifest through each return site.
  const finalizeManifest = (reason: string, completed: number): void => {
    try {
      const changedFiles = changedFilesSince(workspaceDir, runStartSha);
      const planDoc = latestTaskPlanDocument(workspaceDir);
      const inputText = inputs || "";
      // Conservative plan↔run match (P15 review): full spec/plan path matches and
      // the exact issue-key form are specific. The bare task-key match is
      // boundary-guarded (whole token, not an arbitrary substring) so a short or
      // stale key can't accidentally match an unrelated run's inputs and attach a
      // misleading scope-drift note.
      const keyIsWholeToken = (hay: string, key: string): boolean => {
        if (!key) return false;
        const boundary = (c: string) => c === "" || !/[A-Za-z0-9_-]/.test(c);
        for (
          let idx = hay.indexOf(key);
          idx >= 0;
          idx = hay.indexOf(key, idx + 1)
        ) {
          const before = idx === 0 ? "" : hay[idx - 1];
          const after = hay[idx + key.length] ?? "";
          if (boundary(before) && boundary(after)) return true;
        }
        return false;
      };
      const planMatchesRun =
        planDoc != null &&
        (keyIsWholeToken(inputText, planDoc.taskKey) ||
          inputText.includes(planDoc.specPath) ||
          inputText.includes(planDoc.planPath) ||
          planDoc.taskKey === `issue-${inputText}`);
      const scopeDrift =
        planDoc && planMatchesRun
          ? detectScopeDrift(planDoc.doc, changedFiles)
          : null;
      // Verification matrix (issue #181 P24): a --verify run's stage writes a
      // machine-readable matrix to the scratch path; parse it back as evidence,
      // relocate its screenshots into the bundle, and keep the parse diagnostics
      // so a missing/malformed/partial matrix surfaces a visible verification
      // failure rather than silently omitting the gate (#181 review).
      let verification: RunManifest["verification"];
      let verificationDropped = 0;
      if (mode === "verify" && existsSync(verifyMatrixPath)) {
        const result = parseVerificationMatrixWithDiagnostics(
          readFileSync(verifyMatrixPath, "utf8")
        );
        verificationDropped = result.dropped;
        if (result.entries.length > 0) {
          verification = relocateVerificationScreenshots(
            result.entries,
            workspaceDir,
            runId
          );
        }
      }
      const manifestForReport: RunManifest = {
        runId,
        bin,
        mode,
        inputs,
        runtime: { id: activeAgentId, displayName: activeAgentDisplayName },
        branchStrategy,
        iterations: total,
        completedIterations: completed,
        costUsd: runCostUsd,
        tokenUsage: runTokenUsage,
        exitReason: reason,
        nextAction: nextActionFor(reason),
        artifacts: [],
        ...(inputSharpness
          ? {
              inputSharpness: {
                metCount: inputSharpness.metCount,
                maxScore: inputSharpness.maxScore,
                unknowns: inputSharpness.unknowns,
              },
            }
          : {}),
        ...(verification ? { verification } : {}),
        ...(mode === "verify" && verificationDropped > 0
          ? { verificationDropped }
          : {}),
        startedAt: manifestStartedAt,
        finishedAt: nowIso(),
      };
      const report = finalizeReportText(lastReportText, {
        manifest: manifestForReport,
        stages: readStageRecords(workspaceDir, runId),
        headSha: headSha(workspaceDir),
        changedFiles,
        scopeDrift,
      });
      writeRunReport(workspaceDir, runId, report);
      writeManifest(workspaceDir, {
        runId,
        bin,
        mode,
        inputs,
        runtime: { id: activeAgentId, displayName: activeAgentDisplayName },
        branchStrategy,
        iterations: total,
        completedIterations: completed,
        costUsd: runCostUsd,
        tokenUsage: runTokenUsage,
        exitReason: reason,
        nextAction: nextActionFor(reason),
        artifacts: collectArtifacts(),
        ...(runSkillsUsed.length > 0 ? { skillsUsed: runSkillsUsed } : {}),
        ...(inputSharpness
          ? {
              inputSharpness: {
                metCount: inputSharpness.metCount,
                maxScore: inputSharpness.maxScore,
                unknowns: inputSharpness.unknowns,
              },
            }
          : {}),
        ...(verification ? { verification } : {}),
        ...(mode === "verify" && verificationDropped > 0
          ? { verificationDropped }
          : {}),
        startedAt: manifestStartedAt,
        finishedAt: nowIso(),
      });
    } catch {
      // Best-effort: never fail a run because the manifest could not be finalized.
    }
  };

  // One consistent end-of-run summary across every terminal path: the exit
  // reason, iterations run, and cumulative cost, then a next-action hint so a
  // maintainer reading the final line knows what to do next. Written to stdout
  // (like the other completion lines) so it survives `> out.txt` redirection.
  // Also finalizes the run manifest here so the evidence bundle records the same
  // exit reason on every terminal path the loop funnels through summarize.
  const summarize = (reason: string, iterations: number): void => {
    // Build a finalized manifest snapshot (same fields finalizeManifest writes)
    // so buildRunView can derive status/elapsedMs from it. hasFollowups is kept
    // false here — the deferred-count line is written separately below to
    // preserve the greppable count format ("N deferred follow-ups …").
    const nowTs = nowIso();
    const manifestSnap: RunManifest = {
      runId,
      bin,
      mode,
      inputs,
      runtime: { id: activeAgentId, displayName: activeAgentDisplayName },
      branchStrategy,
      iterations: total,
      completedIterations: iterations,
      costUsd: runCostUsd,
      tokenUsage: runTokenUsage,
      exitReason: reason,
      nextAction: nextActionFor(reason),
      artifacts: [] as RunArtifact[],
      startedAt: manifestStartedAt,
      finishedAt: nowTs,
    };
    const view = buildRunView(
      manifestSnap,
      stageLog as unknown as StageRecord[]
    );
    let out = formatDoneCard(view) + "\n";
    // Runtime label + optional token usage: keeps the greppable "runtime: <id>"
    // in stdout (tests check for it) and the token count assertion.
    const runtimeLabel = switched
      ? `${switchFromId} -> ${activeAgentId} (switched once: rate limit)`
      : activeAgentId;
    out += `${dimOut(`  runtime: ${runtimeLabel}`)}`;
    if (tokenMode !== "off") {
      out += `${dimOut(` · tokens ${formatTokenUsage(runTokenUsage)}`)}`;
    }
    out += "\n";
    // Deferred follow-ups: written with the count so the greppable format
    // ("N deferred follow-ups in .otto/review-followups.md") is preserved.
    const deferred = deferredFollowupCount(workspaceDir);
    if (deferred > 0) {
      out += `${dimOut(`  ⚑ ${deferred} deferred follow-up${deferred === 1 ? "" : "s"} in .otto/review-followups.md`)}\n`;
    }
    process.stdout.write(out);
    finalizeManifest(reason, iterations);
  };
  let sawFailure = false;
  // Adaptive compute router (issue #41): per-iteration progress state. The loop
  // observes the diff a change produced and the cumulative cost; failing-check
  // and failure-signature observability is future work, so the active policy
  // outcome today is the diff-stall early stop (a run that stops changing files).
  let prevObservation: IterationObservation | null = null;
  let stalledIterations = 0;

  if (resuming) {
    resumeNote = `Resumed run (iteration ${startIteration} of ${total}). Prior work may already be committed or partially applied. Reconcile against git history and the working tree before acting; do not redo completed tasks.`;
    process.stdout.write(
      `${greenOut(SYM_OUT.bullet)} ${boldOut("resuming")}${dimOut(` from iteration ${startIteration}/${total}`)}\n`
    );
  }
  const persist = (
    iteration: number,
    status: RunState["status"],
    resetsAt?: number | null
  ): void =>
    writeState(workspaceDir, {
      bin,
      mode,
      inputs,
      iteration,
      of: total,
      status,
      resetsAt: resetsAt ?? null,
      agent: activeAgentId,
      startedAt: prior?.startedAt ?? nowIso(),
      updatedAt: nowIso(),
    });

  const resolveCheckpointDecision = async (prompt: string) =>
    resolvePlanCheckpoint(prompt, {
      interactive:
        Boolean(process.stdin.isTTY) &&
        Boolean(process.stdout.isTTY) &&
        !externalSignal,
      timeoutMs: PLAN_CHECKPOINT_TIMEOUT_MS,
      out: (msg) => process.stderr.write(`${msg}\n`),
      readLine: async (signal) => {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          return signal
            ? await rl.question("", { signal })
            : await rl.question("");
        } finally {
          rl.close();
        }
      },
    });

  const handlePlanCompletion = async (): Promise<
    "accept" | "replan" | "pause"
  > => {
    if (mode !== "plan") return "accept";
    const planDoc = latestTaskPlanDocument(workspaceDir);
    if (!planDoc) return "accept";
    const score = scorePlanQuality(planDoc.doc);
    const depth = scorePlanDepth(planDoc.doc);
    const gate = assessPlanGate(score, { depth });
    process.stderr.write(`${formatPlanGate(gate)}\n`);
    if (!gate.passed) {
      process.stderr.write(`${formatPlanDepthRubric(depth)}\n`);
      if (!planReplanUsed) {
        planReplanUsed = true;
        resumeNote = [
          "The authored plan failed Otto's semantic plan gate. Re-plan once before stopping.",
          formatPlanGate(gate),
          formatPlanDepthRubric(depth),
          `Rewrite ${planDoc.specPath} and ${planDoc.planPath}; keep the same task key unless the original key was wrong.`,
        ].join("\n\n");
        process.stderr.write(
          `${dim("plan gate failed — re-running the plan stage once with the shortfall")}\n`
        );
        return "replan";
      }
      process.stderr.write(
        `${dim("plan gate still failed after one re-plan — pausing for human review")}\n`
      );
      return "pause";
    }
    const prompt = [
      formatCheckpointPrompt({
        taskKey: planDoc.taskKey,
        planPath: planDoc.planPath,
        score,
      }),
      formatPlanDepthRubric(depth),
      formatPlanGate(gate),
    ].join("\n");
    keyboardControls?.cleanup();
    const decision = await resolveCheckpointDecision(prompt);
    return decision === "approve" ? "accept" : "pause";
  };

  if (resuming && prior!.status === "waiting-rate-limit") {
    const waitMs = computeWaitMs(
      prior!.resetsAt ?? null,
      Date.now(),
      RATE_LIMIT_BUFFER_MS,
      0
    );
    if (waitMs > 0 && waitMs <= maxWaitMs) {
      process.stderr.write(
        `${dim(`waiting ${Math.round(waitMs / 60000)}m to clear the prior rate limit`)}\n`
      );
      await sleep(waitMs, activeSignal);
    }
  }

  // Input sharpening (issue #180 P23): show the operator the input-sharpness
  // scorecard at run start so the gaps the plan author must assume are visible
  // up front, mirroring how the plan gate prints its rubric.
  if (inputSharpness) {
    process.stderr.write(`${dim(formatInputSharpness(inputSharpness))}\n`);
  }

  try {
    for (let i = startIteration; i <= total; i++) {
      persist(i, "running");
      // Adaptive router / model routing: snapshot HEAD at iteration start so a
      // stage can classify the change this iteration produced before routing its
      // review depth (P2) or model tier (P11).
      const iterStartSha =
        adaptiveRouter || modelRouting ? headSha(workspaceDir) : null;

      // Sub-agent fan-out (issue #66 P11): on the first iteration only, land the
      // plan's independent tasks in parallel worktrees before the sequential
      // loop. Deferred or absent work flows through the normal implementer below
      // — fan-out is an accelerator, never a correctness dependency.
      let fanoutLanded = 0;
      if (fanOut && i === startIteration) {
        const planTasks = discoverPlanTasks(workspaceDir);
        if (planTasks.length === 0) {
          process.stderr.write(
            `${dim("fan-out: no valid .otto/tasks/<key>/tasks.json — running sequentially")}\n`
          );
        } else {
          reapWorktrees(workspaceDir);
          process.stderr.write(
            `${bold(SYM.bullet)} ${bold("fan-out")} ${dim(`· ${planTasks.length} task(s), concurrency ${fanOutConcurrency}`)}\n`
          );
          const fr = await runFanout({
            tasks: planTasks,
            workspaceDir,
            packageDir,
            iteration: i,
            maxRetries,
            cooldownMs,
            concurrency: fanOutConcurrency,
            ladder: tierLadder ?? resolveTierLadder(),
            routing: modelRouting,
            runtimeId: activeAgentId,
            signal: activeSignal,
            onSubAgent: accountStage,
          });
          fanoutLanded = fr.outcomes.filter(
            (o) => o.status === "landed"
          ).length;
          process.stderr.write(
            `${dim(SYM.cont)} ${greenOut(String(fanoutLanded))} landed, ${fr.deferred.length} deferred ${dim("(deferred tasks continue in the sequential loop)")}\n`
          );
        }
      }

      // Issue #177: a `--plan` run whose fan-out landed implementation work was
      // an implement, not a re-plan. Review the aggregated fan-out diff instead
      // of re-authoring the next slice over the slice docs, then finalize as an
      // implementation run. When this does not apply (no fan-out work, not plan
      // mode, no reviewer), the normal stage chain runs unchanged.
      const reviewFanout = reviewsFanoutInsteadOfReplan({
        mode,
        fanOut,
        landed: fanoutLanded,
        hasReviewStage: reviewStage != null,
      });
      const iterationStages: [Stage, ...Stage[]] = reviewFanout
        ? [reviewStage!]
        : stages;
      if (reviewFanout) {
        process.stderr.write(
          `${dim("fan-out landed implementation work — reviewing the aggregated diff instead of re-planning (issue #177)")}\n`
        );
      }

      for (let s = 0; s < iterationStages.length; s++) {
        const stage = iterationStages[s];

        // Budget gate: check before running each stage.
        if (budgetUsd != null && runCostUsd >= budgetUsd) {
          summarize("stopped (budget)", i - 1);
          return outcome();
        }

        const banner = USE_COLOR
          ? `${dim("━━━")} ${bold(`iteration ${i}/${total}`)} ${dim("·")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${iterationStages.length})`)} ${dim("·")} ${bold(activeAgentDisplayName)} ${dim("━━━")}`
          : `== iteration ${i}/${total} · ${stage.name} (stage ${s + 1}/${iterationStages.length}) · ${activeAgentDisplayName} ==`;
        process.stderr.write(`\n${banner}\n`);
        sink.setStage(i, stage.name);

        // Model routing (issue #66 P11): classify this iteration's change so
        // routeModel can modulate the per-stage tier (security/cross-module up,
        // docs/test down). Computed when model routing is on, independent of the
        // review router. The single reviewer/implementer/plan/verify stages route
        // through executeStage below; panel lenses route per-lens (review-severity
        // tiers) inside runPanel when modelRouting is on.
        const riskAssessment = modelRouting
          ? classifyRisk(
              resolveChangedPaths
                ? resolveChangedPaths(workspaceDir)
                : changedFilesSince(workspaceDir, iterStartSha)
            )
          : undefined;

        // Adaptive router: route this iteration's review depth by change risk,
        // selecting a per-iteration subset of the lens pool. Off → static pool.
        let effectiveLenses = reviewLenses;
        if (
          adaptiveRouter &&
          stage.name === "reviewer" &&
          reviewLenses &&
          reviewLenses.length > 0
        ) {
          const changed = resolveChangedPaths
            ? resolveChangedPaths(workspaceDir)
            : changedFilesSince(workspaceDir, iterStartSha);
          const route = routeReview(changed, reviewLenses);
          effectiveLenses = route.lenses;
          if (explainRouting) {
            // Full reasoning (class/risk/signals/depth/lenses), one line per row.
            for (const line of formatRouting(route).split("\n")) {
              process.stderr.write(`${dim(`↳ ${line}`)}\n`);
            }
          } else {
            const how = route.lenses.length
              ? `${route.depth} (${route.lenses.join(", ")})`
              : "single reviewer";
            process.stderr.write(
              `${dim(`↳ adaptive router: ${route.assessment.class} → ${how}`)}\n`
            );
          }
        }

        const usePanel =
          effectiveLenses &&
          effectiveLenses.length > 0 &&
          stage.name === "reviewer";

        let sr: StageResult;
        const runOnce = async (): Promise<StageResult> => {
          if (usePanel) {
            const { runPanel } = await import("./panel.js");
            return runPanel({
              lenses: effectiveLenses!,
              workspaceDir,
              packageDir,
              iteration: i,
              maxRetries,
              cooldownMs,
              tokenMode,
              signal: activeSignal,
              agentId: activeAgentId,
              resumeNote,
              changedPaths: resolveChangedPaths
                ? resolveChangedPaths(workspaceDir)
                : changedFilesSince(workspaceDir, iterStartSha),
              adaptiveRouter,
              modelRouting,
              tierLadder,
              riskAssessment,
              onStage: accountStage,
              recordStage: (stageName, subSr, startedAt, reviewSeverity) =>
                recordStage(i, stageName, subSr, startedAt, reviewSeverity),
            });
          }
          // P18: route validated skills for this stage and inject a bounded,
          // attributed block via the `{{ SKILLS }}` template var (empty when
          // activation is off, so the rendered prompt is unchanged).
          const skillChanged = skillsActive
            ? resolveChangedPaths
              ? resolveChangedPaths(workspaceDir)
              : iterStartSha
                ? changedFilesSince(workspaceDir, iterStartSha)
                : []
            : [];
          const injected = injectSkills(stage.name, skillChanged);
          const r = await executeStage({
            stage,
            vars: {
              INPUTS: inputs,
              RESUME: resumeNote,
              SHARPENING: sharpeningGuidance,
            },
            injectedContext: injected.block,
            workspaceDir,
            packageDir,
            iteration: i,
            maxRetries,
            tokenMode,
            signal: activeSignal,
            agentId: activeAgentId,
            sink,
            modelRouting,
            tierLadder,
            riskAssessment,
            escalations: modelEscalations,
            compressor,
            retrievalStore,
          });
          if (injected.usages.length > 0) {
            r.skillsUsed = injected.usages;
            runSkillsUsed.push(...injected.usages);
          }
          accountStage(r);
          if (explainRouting && modelRouting && r.routedTier) {
            const note = r.modelSource === "route" ? "" : ` [${r.modelSource}]`;
            process.stderr.write(
              `${dim(`↳ model route: ${stage.name} → ${r.routedTier} (${r.routedModel ?? "default"})${note}`)}\n`
            );
          }
          return r;
        };

        const stageStartedAt = nowIso();
        try {
          for (;;) {
            const accountingSnapshot = {
              costUsd: runCostUsd,
              tokenUsage: runTokenUsage,
              cooldownFactor,
            };
            // Count of stage records committed before this attempt. A panel
            // attempt records each substage inline as it completes, so a later
            // substage's rate limit (which retries the whole panel) must roll
            // these back too — else stageSeq is monotonic and the retry
            // re-records each lens, duplicating records.
            const recordSnapshot = recordedStageFiles.length;
            try {
              sr = await runOnce();
              break;
            } catch (err) {
              if ((err as Error)?.name !== "RateLimitError") throw err;
              // A panel attempt may have accounted completed sub-agents before
              // a later sub-agent rate-limited. The whole panel is retried, so
              // rollback that failed attempt's accounting before waiting. The
              // per-stage cost/token lines already printed to stderr can't be
              // un-printed — emit a note so the running totals still reconcile.
              const discardedCost = runCostUsd - accountingSnapshot.costUsd;
              if (discardedCost > 0) {
                process.stderr.write(
                  `${dim(`↩ discarding rate-limited attempt's partial accounting (−$${discardedCost.toFixed(2)})`)}\n`
                );
              }
              runCostUsd = accountingSnapshot.costUsd;
              runTokenUsage = accountingSnapshot.tokenUsage;
              cooldownFactor = accountingSnapshot.cooldownFactor;
              // Mirror the accounting rollback for evidence records: drop the
              // failed attempt's inline panel substage records so the retry
              // re-records into the same seqs instead of duplicating them.
              const discardedRecords =
                recordedStageFiles.splice(recordSnapshot);
              if (discardedRecords.length > 0) {
                removeStageRecords(workspaceDir, runId, discardedRecords);
                stageLog.splice(recordSnapshot);
              }
              const resetsAt = (err as RateLimitError).resetsAt;

              // Auto-switch on limit: when a fallback runtime is configured and
              // we are not already on it, switch at this stage boundary and
              // re-run the stage on the fallback instead of waiting for reset.
              // Budget/token totals were just rolled back to the snapshot, so
              // accounting survives the switch. Only one switch happens (once
              // active === fallback the condition is false), so a fallback that
              // also limits falls through to the normal wait/halt path.
              if (
                autoSwitchOnLimit &&
                fallbackAgentId &&
                activeAgentId !== fallbackAgentId
              ) {
                try {
                  getAgentRuntime(fallbackAgentId);
                } catch (switchErr) {
                  const fallbackName = fallbackDisplayName ?? fallbackAgentId;
                  process.stderr.write(
                    `${dim(`auto-switch skipped: ${fallbackName} is unavailable (${(switchErr as Error).message}); waiting for ${activeAgentDisplayName} reset`)}\n`
                  );
                  const waitMs = computeWaitMs(
                    resetsAt,
                    Date.now(),
                    RATE_LIMIT_BUFFER_MS,
                    RATE_LIMIT_FALLBACK_MS
                  );
                  if (waitMs > maxWaitMs) {
                    persist(i, "interrupted", resetsAt);
                    process.stderr.write(
                      `${dim(`reset is beyond --max-wait; re-run to resume from iteration ${i}`)}\n`
                    );
                    summarize("halted (rate limit)", i - 1);
                    return outcome();
                  }
                  persist(i, "waiting-rate-limit", resetsAt);
                  const mins = Math.round(waitMs / 60000);
                  process.stderr.write(
                    `${dim(`⏸ rate limit — waiting ~${mins}m until reset, then resuming`)}\n`
                  );
                  await sleep(waitMs, activeSignal);
                  persist(i, "running");
                  continue;
                }

                const fromName = activeAgentDisplayName;
                activeAgentId = fallbackAgentId;
                activeAgentDisplayName = fallbackDisplayName ?? fallbackAgentId;
                switched = true;
                resumeNote = `Auto-switched from ${fromName} to ${activeAgentDisplayName} after a rate limit while rerunning iteration ${i} stage ${stage.name}. The previous attempt may have made partial workspace changes before it stopped. Reconcile against git history and the working tree before acting; do not redo completed tasks or partial edits.`;
                process.stderr.write(
                  `${dim(`↪ auto-switch on rate limit: ${fromName} → ${activeAgentDisplayName} for iteration ${i} ${stage.name}`)}\n`
                );
                persist(i, "running");
                continue;
              }

              const waitMs = computeWaitMs(
                resetsAt,
                Date.now(),
                RATE_LIMIT_BUFFER_MS,
                RATE_LIMIT_FALLBACK_MS
              );
              if (waitMs > maxWaitMs) {
                persist(i, "interrupted", resetsAt);
                process.stderr.write(
                  `${dim(`reset is beyond --max-wait; re-run to resume from iteration ${i}`)}\n`
                );
                summarize("halted (rate limit)", i - 1);
                return outcome();
              }
              persist(i, "waiting-rate-limit", resetsAt);
              const mins = Math.round(waitMs / 60000);
              process.stderr.write(
                `${dim(`⏸ rate limit — waiting ~${mins}m until reset, then resuming`)}\n`
              );
              await sleep(waitMs, activeSignal);
              persist(i, "running");
            }
          }
        } catch (err) {
          if (activeSignal.aborted) {
            summarize("aborted", i - 1);
            return outcome();
          }
          const stageLog = stageLogPath(
            workspaceDir,
            i,
            stage.name,
            activeAgentId
          );
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          sawFailure = true;
          break;
        }

        // Cost/pacing accounting is handled by accountStage — called once per
        // non-panel stage above, and once per sub-agent inside runPanel.

        // Record this stage's evidence. A panel stage already recorded its own
        // substages (lens/verify/synth) via the threaded recordStage, so skip
        // the umbrella record to avoid double-counting the synth result.
        if (!usePanel) recordStage(i, stage.name, sr!, stageStartedAt);

        // Persist the most recent emitted quality report so otto-explain can
        // re-render this run for a non-engineer. Keyed on the report's content
        // marker, then trimmed to the report body so the sentinel/log chatter is
        // not stored in report.md.
        if (sr!.result && hasRunReport(sr!.result)) {
          lastReportText = extractRunReport(sr!.result);
          // Emit-time report rubric gate (P15 #85): when the captured
          // model-emitted report fails the legibility rubric, run a dedicated
          // lightweight rewrite stage ONCE to regenerate a compliant report,
          // then accept whatever it returns. Latched to one rewrite per run
          // (mirrors the P13 re-plan latch). Only the model-emitted branch is
          // hooked, so the harness fallback report never triggers it.
          if (lastReportText && !reportRewriteUsed) {
            const score = scoreReportLegibility(lastReportText);
            if (score.ratio < DEFAULT_REPORT_LEGIBILITY_THRESHOLD) {
              reportRewriteUsed = true;
              process.stderr.write(
                `${dim(`report gate: FAIL — rewriting once (missing ${score.missing.join(", ")})`)}\n`
              );
              const rwStartedAt = nowIso();
              const rw = await executeStage({
                stage: REPORT_REWRITE_STAGE,
                vars: {
                  RESUME: resumeNote,
                  REPORT: lastReportText,
                  MISSING: score.missing.join(", "),
                },
                workspaceDir,
                packageDir,
                iteration: i,
                maxRetries,
                tokenMode,
                signal: activeSignal,
                agentId: activeAgentId,
                sink,
                modelRouting,
                tierLadder,
                riskAssessment,
                escalations: modelEscalations,
              });
              accountStage(rw);
              recordStage(i, REPORT_REWRITE_STAGE.name, rw, rwStartedAt);
              if (rw.result && hasRunReport(rw.result)) {
                lastReportText = extractRunReport(rw.result) ?? lastReportText;
              }
            }
          }
        }

        if (s === 0 && !reviewFanout) {
          if (sr!.result.includes(SENTINEL)) {
            const planDecision = await handlePlanCompletion();
            if (planDecision === "replan") {
              s -= 1;
              continue;
            }
            if (planDecision === "pause") {
              summarize("paused (needs human)", i);
              persist(i, "interrupted");
              return outcome();
            }
            sentinelHit = true;
            completedIterations = i;
            summarize("complete", i);
            persist(i, "complete");
            clearState(workspaceDir);
            return outcome();
          }
          // Gate stage did not finish the work — track failures to escalate the
          // model tier on a persistently wedged run (issue #66 P11).
          gateFailureStreak = sr!.isError ? gateFailureStreak + 1 : 0;
          modelEscalations = Math.max(0, gateFailureStreak - 1);
        }
        await keyboardControls.pauseIfRequested();
      }
      completedIterations = i;

      // Issue #177: the fan-out implement-and-review path is a one-shot — the
      // reviewer has now seen the aggregated diff, so finalize as a complete
      // implementation run rather than continuing to the plan re-author chain.
      if (reviewFanout) {
        summarize("complete", i);
        persist(i, "complete");
        clearState(workspaceDir);
        return outcome();
      }
      await keyboardControls.pauseIfRequested();

      // Adaptive iteration control: feed this iteration's progress signals into
      // the policy and act on early-stop / escalate / confident-finish. Off by
      // default; the static fixed-N behavior is unchanged when the flag is absent.
      if (adaptiveRouter && i < total) {
        const iterChanged = resolveChangedPaths
          ? resolveChangedPaths(workspaceDir)
          : changedFilesSince(workspaceDir, iterStartSha);
        const cur: IterationObservation = {
          diffSignature: [...iterChanged].sort().join("|"),
          failingChecks: null,
          failureSignature: null,
          findingSignatures: [],
          cumulativeCostUsd: runCostUsd,
        };
        stalledIterations =
          iterChanged.length === 0 ? stalledIterations + 1 : 0;
        const signals = deriveProgress(cur, prevObservation);
        prevObservation = cur;
        const decision = decide(signals, {
          stalledIterations,
          repeatedFailureStreak: 0,
          failingChecks: null,
        });
        // Under --explain-routing, surface the progress decision every iteration
        // (including `continue`), so the operator sees why the run kept going.
        if (explainRouting && decision.action === "continue") {
          process.stderr.write(
            `${dim(`↳ progress: continue — ${decision.reason}`)}\n`
          );
        }
        if (decision.action !== "continue") {
          process.stderr.write(
            `${dim(`↳ adaptive router: ${decision.action} — ${decision.reason}`)}\n`
          );
          const reason =
            decision.action === "stop-low-progress"
              ? "stopped (low progress)"
              : decision.action === "escalate-pause"
                ? "paused (needs human)"
                : "complete";
          summarize(reason, i);
          clearState(workspaceDir);
          return outcome();
        }
      }

      // Cooldown between iterations.
      if (cooldownMs > 0 && i < total) {
        const wait = cooldownMs * cooldownFactor;
        if (cooldownFactor > 1) {
          process.stderr.write(
            `${dim(`cooldown ×${cooldownFactor} → ${wait}ms (throttle backoff)`)}\n`
          );
        }
        await sleep(wait, activeSignal);
      }
    }
  } catch (err) {
    // A graceful abort (e.g. watch-mode shutdown during the inter-iteration
    // cooldown sleep) rejects past the inner stage guard into here — report it
    // as an abort, not an error, matching the mid-stage abort path above.
    if (activeSignal.aborted) {
      summarize("aborted", completedIterations);
      return outcome();
    }
    if (notify) notifyError((err as Error).message);
    summarize("stopped (error)", completedIterations);
    throw err;
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    keyboardControls.cleanup();
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === total)) {
      notifyComplete(completedIterations, sentinelHit);
    }
    // Public journal (issue #67 P12): at run end, optionally draft/post a
    // generic field note through the secrecy gate. A no-op unless the repo opts
    // in via .otto/config.json; never throws and never affects the run outcome.
    if (!activeSignal.aborted) {
      try {
        await maybeJournal({
          workspaceDir,
          packageDir,
          iteration: completedIterations || 1,
          maxRetries,
          agentId: activeAgentId,
          signal: activeSignal,
        });
      } catch {
        // the journal must never affect a run's outcome.
      }
    }
  }
  summarize(sawFailure ? "done with failures" : "done", completedIterations);
  clearState(workspaceDir);
  return outcome();
}
