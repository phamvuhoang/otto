import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_DISPLAY_NAMES, type AgentRuntimeId } from "./agent-runtime.js";
import { readCoreVersion } from "./cli-help.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { changedFilesSince, headSha } from "./git.js";
import { sleep, isThrottle, nextCooldownFactor } from "./pacing.js";
import { decide } from "./policy.js";
import { deriveProgress, type IterationObservation } from "./progress.js";
import { explainRouting as formatRouting, routeReview } from "./risk.js";
import { RateLimitError, computeWaitMs } from "./rate-limit.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import { cleanScratch } from "./scratch.js";
import { getAgentRuntime, stageLogPath, type StageResult } from "./runner.js";
import {
  allocateRunId,
  hasRunReport,
  removeStageRecords,
  writeManifest,
  writeRunReport,
  writeStageRecord,
  type RunArtifact,
  type RunManifest,
  type StageRecord,
} from "./run-report.js";
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

const RATE_LIMIT_BUFFER_MS = 30_000;
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
  } = opts;

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
  if (explainRouting && !adaptiveRouter) {
    process.stderr.write(
      `${dim("note: --explain-routing has no effect without --adaptive-router")}\n`
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
    startedAt: string
  ): void => {
    stageLog.push({
      iteration: recIteration,
      stage: stageName,
      isError: sr.isError,
    });
    try {
      const name = writeStageRecord(workspaceDir, runId, recordedStageFiles.length, {
        iteration: recIteration,
        stage: stageName,
        runtimeId: sr.runtimeId ?? activeAgentId,
        costUsd: sr.costUsd,
        usage: sr.usage,
        isError: sr.isError,
        apiErrorStatus: sr.apiErrorStatus,
        safetyEvents: sr.safetyEvents,
        contextBreakdown: sr.contextBreakdown,
        startedAt,
        finishedAt: nowIso(),
      });
      recordedStageFiles.push(name);
    } catch {
      // Best-effort: never fail a run because a stage record could not be written.
    }
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
  // Most recent emitted quality report (P9 #64), kept so finalize can persist it
  // to the bundle for `otto-explain`. Captured by content marker; null until a
  // stage emits one (afk/plan-mode never does).
  let lastReportText: string | null = null;
  let runCostUsd = 0;
  let runTokenUsage = emptyTokenUsage();
  let cooldownFactor = 1;
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
      // Persist the emitted report before the manifest, so collectArtifacts can
      // detect and link it (best-effort; absent when no stage emitted one).
      if (lastReportText) writeRunReport(workspaceDir, runId, lastReportText);
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
    const view = buildRunView(manifestSnap, stageLog as unknown as StageRecord[]);
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

  try {
    for (let i = startIteration; i <= total; i++) {
      persist(i, "running");
      // Adaptive router: snapshot HEAD at iteration start so the reviewer stage
      // can classify the change this iteration produced before routing its depth.
      const iterStartSha = adaptiveRouter ? headSha(workspaceDir) : null;
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];

        // Budget gate: check before running each stage.
        if (budgetUsd != null && runCostUsd >= budgetUsd) {
          summarize("stopped (budget)", i - 1);
          return outcome();
        }

        const banner = USE_COLOR
          ? `${dim("━━━")} ${bold(`iteration ${i}/${total}`)} ${dim("·")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("·")} ${bold(activeAgentDisplayName)} ${dim("━━━")}`
          : `== iteration ${i}/${total} · ${stage.name} (stage ${s + 1}/${stages.length}) · ${activeAgentDisplayName} ==`;
        process.stderr.write(`\n${banner}\n`);
        sink.setStage(i, stage.name);

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
          effectiveLenses && effectiveLenses.length > 0 && stage.name === "reviewer";

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
              onStage: accountStage,
              recordStage: (stageName, subSr, startedAt) =>
                recordStage(i, stageName, subSr, startedAt),
            });
          }
          const r = await executeStage({
            stage,
            vars: { INPUTS: inputs, RESUME: resumeNote },
            workspaceDir,
            packageDir,
            iteration: i,
            maxRetries,
            tokenMode,
            signal: activeSignal,
            agentId: activeAgentId,
            sink,
          });
          accountStage(r);
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
              const discardedRecords = recordedStageFiles.splice(recordSnapshot);
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
        // re-render this run for a non-engineer (P9 #64). Keyed on the report's
        // content marker — the implementer emits it; afk/plan-mode emits none.
        if (sr!.result && hasRunReport(sr!.result)) lastReportText = sr!.result;

        if (s === 0) {
          if (sr!.result.includes(SENTINEL)) {
            sentinelHit = true;
            completedIterations = i;
            summarize("complete", i);
            persist(i, "complete");
            clearState(workspaceDir);
            return outcome();
          }
        }
        await keyboardControls.pauseIfRequested();
      }
      completedIterations = i;
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
        stalledIterations = iterChanged.length === 0 ? stalledIterations + 1 : 0;
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
