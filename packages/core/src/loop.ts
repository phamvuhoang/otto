import { appendFileSync } from "node:fs";

import { readCoreVersion } from "./cli-help.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep, isThrottle, nextCooldownFactor } from "./pacing.js";
import { RateLimitError, computeWaitMs } from "./rate-limit.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import { stageLogPath, type StageResult } from "./runner.js";
import { executeStage } from "./stage-exec.js";
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

// The agent emits this literal when there is no more work; the same string is
// mirrored in the playbook templates (prompt.md / ghprompt.md) that instruct it.
const SENTINEL = "<promise>NO MORE TASKS</promise>";

const RATE_LIMIT_BUFFER_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 6 * 3600_000;

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
  /** Opt-in reviewer panel: replace the single reviewer stage with K read-only lens reviewers + one synth commit. */
  reviewLenses?: string[];
  /** Injected AbortSignal for daemon callers (e.g. watch mode). When provided,
   *  runLoop skips wake-lock acquisition and process signal handler installation;
   *  the caller owns both. */
  signal?: AbortSignal;
  /** Run mode for state.json identity (e.g. "afk" / "ghafk"). Default "afk". */
  mode?: string;
  /** Cap on the rate-limit wait before halting. Default 6h. */
  maxWaitMs?: number;
  /** Force a fresh run, ignoring/clearing prior state. Default false. */
  fresh?: boolean;
};

export type LoopOutcome = { costUsd: number; sentinelHit: boolean };

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
    reviewLenses,
    signal: externalSignal,
    mode = "afk",
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    fresh = false,
  } = opts;

  const versionLine = `${bin} ${cliVersion} (core ${readCoreVersion()})`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );

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
  if (!externalSignal) {
    const abortActiveStage = (): void => {
      if (!stageAbort!.signal.aborted) stageAbort!.abort();
    };
    onSigint = (): void => {
      abortActiveStage();
      if (notify) notifyError("interrupted (SIGINT)");
      releaseOnce();
      process.exit(130);
    };
    onSigterm = (): void => {
      abortActiveStage();
      if (notify) notifyError("terminated (SIGTERM)");
      releaseOnce();
      process.exit(143);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  let completedIterations = 0;
  let sentinelHit = false;
  let runCostUsd = 0;
  let cooldownFactor = 1;

  // Single source of truth for per-stage accounting: tally cost, report it,
  // advance the adaptive cooldown factor on throttle, and report whether the
  // budget is now exhausted. Used once per non-panel stage AND once per panel
  // sub-agent (passed to runPanel as onStage), so budget + adaptive pacing
  // apply uniformly to lenses, synth, and ordinary stages alike.
  const accountStage = (
    sr: StageResult
  ): { stop: boolean; cooldownFactor: number } => {
    runCostUsd += sr.costUsd;
    process.stderr.write(
      `${dim(`· $${sr.costUsd.toFixed(2)} (run $${runCostUsd.toFixed(2)})`)}\n`
    );
    cooldownFactor = nextCooldownFactor(
      cooldownFactor,
      isThrottle(sr.apiErrorStatus)
    );
    return {
      stop: budgetUsd != null && runCostUsd >= budgetUsd,
      cooldownFactor,
    };
  };

  const nowIso = () => new Date().toISOString();
  if (fresh) clearState(workspaceDir);
  const prior = fresh ? null : readState(workspaceDir);
  const resuming = matchesResume(prior, { bin, mode, inputs });
  const startIteration = resuming ? prior!.iteration : 1;
  const total = resuming ? prior!.of : iterations;
  let resumeNote = "";
  if (resuming) {
    resumeNote = `Resumed run (iteration ${startIteration} of ${total}). Prior work is committed — reconcile against git history and the working tree before acting; do not redo completed tasks.`;
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
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];

        // Budget gate: check before running each stage.
        if (budgetUsd != null && runCostUsd >= budgetUsd) {
          process.stdout.write(
            `${greenOut(SYM_OUT.bullet)} ${boldOut("budget reached")}${dimOut(` $${runCostUsd.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} after ${i - 1} iterations`)}\n`
          );
          return { costUsd: runCostUsd, sentinelHit };
        }

        const banner = USE_COLOR
          ? `${dim("━━━")} ${bold(`iteration ${i}/${total}`)} ${dim("·")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("━━━")}`
          : `== iteration ${i}/${total} · ${stage.name} (stage ${s + 1}/${stages.length}) ==`;
        process.stderr.write(`\n${banner}\n`);

        const usePanel =
          reviewLenses && reviewLenses.length > 0 && stage.name === "reviewer";

        let sr: StageResult;
        const runOnce = async (): Promise<StageResult> => {
          if (usePanel) {
            const { runPanel } = await import("./panel.js");
            return runPanel({
              lenses: reviewLenses!,
              workspaceDir,
              packageDir,
              iteration: i,
              maxRetries,
              cooldownMs,
              signal: activeSignal,
              onStage: accountStage,
            });
          }
          const r = await executeStage({
            stage,
            vars: { INPUTS: inputs, RESUME: resumeNote },
            workspaceDir,
            packageDir,
            iteration: i,
            maxRetries,
            signal: activeSignal,
          });
          accountStage(r);
          return r;
        };

        try {
          for (;;) {
            try {
              sr = await runOnce();
              break;
            } catch (err) {
              if ((err as Error)?.name !== "RateLimitError") throw err;
              const resetsAt = (err as RateLimitError).resetsAt;
              const waitMs = computeWaitMs(
                resetsAt,
                Date.now(),
                RATE_LIMIT_BUFFER_MS,
                RATE_LIMIT_FALLBACK_MS
              );
              if (waitMs > maxWaitMs) {
                persist(i, "interrupted", resetsAt);
                process.stdout.write(
                  `${red(SYM.cross)} ${bold("rate limit")}${dim(` — reset is beyond --max-wait; halting at iteration ${i}. Re-run to resume.`)}\n`
                );
                return { costUsd: runCostUsd, sentinelHit };
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
            return { costUsd: runCostUsd, sentinelHit };
          }
          const stageLog = stageLogPath(workspaceDir, i, stage.name);
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          break;
        }

        // Cost/pacing accounting is handled by accountStage — called once per
        // non-panel stage above, and once per sub-agent inside runPanel.

        if (s === 0) {
          if (sr!.result.includes(SENTINEL)) {
            const msg =
              greenOut(SYM_OUT.bullet) +
              " " +
              boldOut("Otto complete") +
              dimOut(" after " + i + " iterations");
            process.stdout.write(msg + "\n");
            sentinelHit = true;
            completedIterations = i;
            persist(i, "complete");
            clearState(workspaceDir);
            return { costUsd: runCostUsd, sentinelHit };
          }
        }
      }
      completedIterations = i;

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
    if (notify) notifyError((err as Error).message);
    throw err;
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === total)) {
      notifyComplete(completedIterations, sentinelHit);
    }
  }
  clearState(workspaceDir);
  return { costUsd: runCostUsd, sentinelHit };
}
