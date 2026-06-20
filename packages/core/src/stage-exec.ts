import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { DEFAULT_AGENT, type AgentRuntimeId } from "./agent-runtime.js";
import { analyzeContext } from "./context-report.js";
import { applyPromptReduction } from "./prompt-reduction.js";
import { renderTemplate } from "./render.js";
import { DEFAULT_BACKOFF_MS, backoffFor, withRetries } from "./retry.js";
import {
  getAgentRuntime,
  runStage,
  stageLogPath,
  type StageResult,
} from "./runner.js";
import {
  readSafetyPolicy,
  type PolicyViolation,
} from "./safety-policy.js";
import type { SafetyEvent } from "./run-report.js";
import type { EventSink } from "./console-ui.js";
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
  /** In-run console sink (issue #65 P10), threaded to runStage. Absent → runner default. */
  sink?: EventSink;
};

/** A policy violation found at a shell/@spill tag becomes a `blocked` trajectory
 *  safety event — the command was denied and skipped, so Otto prevented it. */
function violationToSafetyEvent(v: PolicyViolation): SafetyEvent {
  return {
    category: "policy-violation",
    kind: v.kind,
    subject: v.subject,
    message: v.message,
    blocked: true,
  };
}

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
  const runtime = getAgentRuntime(opts.agentId ?? DEFAULT_AGENT);
  // Load the repo-local safety policy once per stage (issue #43 P4). Absent or
  // malformed `.otto/policy.json` → DEFAULT_POLICY (permissive), so the boundary
  // checks threaded into renderTemplate below are a no-op for trusted workflows.
  const policy = readSafetyPolicy(workspaceDir);

  return withRetries(
    async () => {
      // Fresh per attempt: a retried render (flaky shell tag) re-reports its
      // violations, so the surviving attempt's events are the ones recorded.
      const violations: PolicyViolation[] = [];
      let prompt = renderTemplate(
        join(packageDir, "templates", stage.template),
        vars,
        {
          cwd: workspaceDir,
          spillHostDir,
          spillRefPath,
          policy,
          onPolicyViolation: (v) => violations.push(v),
        }
      );
      if (tokenMode === "reduce") {
        const reduced = applyPromptReduction(prompt);
        prompt = reduced.prompt;
        const { originalChars, reducedChars, cacheHits } = reduced.stats;
        process.stderr.write(
          `${dim(`prompt reduce ${originalChars} -> ${reducedChars} chars | cache hits ${cacheHits}`)}\n`
        );
      }
      const result = await runStage(
        stage,
        prompt,
        workspaceDir,
        iteration,
        spillHostDir,
        stageLog,
        { signal, runtime, sink: opts.sink }
      );
      // Attribute the *final* prompt's window footprint by category (issue #62
      // P7). `prompt` is post-reduction, so the breakdown reflects what was sent.
      return {
        ...result,
        contextBreakdown: analyzeContext(prompt),
        ...(violations.length > 0
          ? { safetyEvents: violations.map(violationToSafetyEvent) }
          : {}),
      };
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
