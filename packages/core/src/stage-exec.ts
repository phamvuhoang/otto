import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { AgentRuntimeId } from "./agent-runtime.js";
import { applyPromptReduction } from "./prompt-reduction.js";
import { renderTemplate } from "./render.js";
import { DEFAULT_BACKOFF_MS, backoffFor, withRetries } from "./retry.js";
import { runStage, stageLogPath, type StageResult } from "./runner.js";
import { USE_COLOR, dim } from "./stream-render.js";
import type { Stage } from "./stages.js";
import type { TokenMode } from "./tokens.js";

export type ExecuteStageOptions = {
  stage: Stage;
  vars: Record<string, string>;
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  tokenMode?: TokenMode;
  signal?: AbortSignal;
  /** Disambiguates spill/log paths when multiple sub-stages share an iteration (panel lenses). */
  logLabel?: string;
  /** Active runtime id; suffixes the NDJSON log filename so logs are runtime-labelled. */
  agentId?: AgentRuntimeId;
};

/** Render a stage's template (inside the retry, so flaky shell tags retry) and run it. */
export async function executeStage(
  opts: ExecuteStageOptions
): Promise<StageResult> {
  const {
    stage,
    vars,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    tokenMode = "off",
    signal,
  } = opts;
  const label = opts.logLabel ?? stage.name;
  const spillRel = `spill-${process.pid}-${iteration}-${label}-${Date.now()}`;
  const spillHostDir = join(workspaceDir, ".otto-tmp", spillRel);
  const spillRefPath = posix.join(".otto-tmp", spillRel);
  const stageLog = stageLogPath(workspaceDir, iteration, label, opts.agentId);
  mkdirSync(dirname(stageLog), { recursive: true });

  return withRetries(
    () => {
      let prompt = renderTemplate(
        join(packageDir, "templates", stage.template),
        vars,
        { cwd: workspaceDir, spillHostDir, spillRefPath }
      );
      if (tokenMode === "reduce") {
        const reduced = applyPromptReduction(prompt);
        prompt = reduced.prompt;
        const { originalChars, reducedChars, cacheHits } = reduced.stats;
        process.stderr.write(
          `${dim(`prompt reduce ${originalChars} -> ${reducedChars} chars | cache hits ${cacheHits}`)}\n`
        );
      }
      return runStage(
        stage,
        prompt,
        workspaceDir,
        iteration,
        spillHostDir,
        stageLog,
        { signal }
      );
    },
    {
      max: maxRetries,
      backoffMs: DEFAULT_BACKOFF_MS,
      onAttempt: (attempt, err) => {
        const wait = backoffFor(DEFAULT_BACKOFF_MS, attempt);
        const marker = `[retry] attempt ${attempt} of ${maxRetries} after ${wait} ms`;
        process.stderr.write(
          `${USE_COLOR ? dim(marker) : marker} ${dim("(" + (err as Error).message + ")")}\n`
        );
        try {
          appendFileSync(stageLog, marker + "\n");
        } catch {
          // log file may be unwritable; never crash on the marker.
        }
      },
    }
  );
}
