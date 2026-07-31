import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { DEFAULT_AGENT, type AgentRuntimeId } from "./agent-runtime.js";
import { analyzeContext } from "./context-report.js";
import {
  compressContentSync,
  compressionToolUsage,
  isCompressibleCategory,
  type CompressionCategory,
  type RetrievalStore,
  type SyncContextCompressor,
} from "./context-compressor.js";
import { applyPromptReduction } from "./prompt-reduction.js";
import { renderTemplate } from "./render.js";
import { learningsForPrompt } from "./memory.js";
import { resolveStageModel, type TierLadder } from "./model-tier.js";
import type { RiskAssessment } from "./risk.js";
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
  type SafetyPolicy,
} from "./safety-policy.js";
import type { SafetyEvent, ToolUsage } from "./run-report.js";
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
  /** Model routing on (issue #66 P11). Off ⇒ runtime default model (today's behavior). */
  modelRouting?: boolean;
  /** tier → model ladder; consulted only when routing resolves a tier. */
  tierLadder?: TierLadder;
  /** Change-risk assessment that modulates the routed tier (reused from the P2 router). */
  riskAssessment?: RiskAssessment;
  /** Repeated-failure escalation count that bumps the routed tier. */
  escalations?: number;
  /** Extra sandbox write roots (issue #66 P11): a fan-out sub-agent passes its
   *  parent repo so `git commit` from the worktree reaches the shared `.git`. */
  sandboxWriteRoots?: string[];
  /** Context compressor for @spill output (issue #112 P20); absent/null ⇒ no
   *  compression (today's behavior). Synchronous to fit the sync render path. */
  compressor?: SyncContextCompressor | null;
  /** Where compressed-spill originals are retained (the run's retrieval store);
   *  required for the compressor to store reversible originals. */
  retrievalStore?: RetrievalStore;
  /** Bounded, attributed skill guidance appended to the rendered prompt (issue
   *  #114 P18). Empty/absent ⇒ the prompt is unchanged. Appended after rendering
   *  so it is measured by `analyzeContext` but never disturbs the template. */
  injectedContext?: string;
  /** Base environment for the spawned agent (issue P32); passed unchanged to
   *  `runStage`. A read-only review stage supplies a credential-scrubbed env.
   *  Absent ⇒ runner default (`process.env`). */
  childEnv?: NodeJS.ProcessEnv;
  /** Trusted safety policy pinned by the caller (issue P32). When supplied it is
   *  used verbatim at the render boundary instead of loading a (possibly
   *  contributor-modified) `.otto/policy.json` from the PR head. Absent ⇒
   *  today's `readSafetyPolicy(workspaceDir)` load. */
  safetyPolicy?: SafetyPolicy;
};

/** Map a spill filename to its compression category for evidence attribution. */
function spillCategory(name: string): CompressionCategory {
  const n = name.toLowerCase();
  if (n.includes("issue")) return "issue-body";
  if (
    n.includes("diff") ||
    n.includes("patch") ||
    n.includes("log") ||
    n.includes("commit")
  ) {
    return "command-log";
  }
  return "read-artifact";
}

/** Fallback ladder when routing is requested without one — every tier resolves
 *  to the runtime default (issue #66 P11). The real ladder comes from run-bin. */
const EMPTY_LADDER: TierLadder = {
  cheap: undefined,
  mid: undefined,
  strong: undefined,
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

/** What the harness resolved for a stage's `{{ LEARNINGS }}` var. */
export type PreparedLearnings = { text: string };

/**
 * Resolve the `<learnings>` block the harness injects as `{{ LEARNINGS }}`
 * (P29 Task 2), replacing the wholesale `!?`cat ./.otto/LEARNINGS.md`` tag.
 *
 * Under the 6000-char budget this is the raw file verbatim, so small repos
 * render byte-identically; over budget it becomes a relevance-ranked bounded
 * projection of the governed `.otto/memory/` records — and never a truncation.
 * See {@link resolveLearningsBlock} for the full rule.
 *
 * Compression of this block (the compressor's `memory-projection` category) is
 * deliberately NOT wired here: spec D6 gates it on measurement, because
 * authorizing a category obligates the P22 fact-survival gate (#200) for it and
 * the block is already capped at 6000 chars.
 */
export function prepareLearnings(opts: {
  workspaceDir: string;
  taskKey?: string;
  env?: NodeJS.ProcessEnv;
}): PreparedLearnings {
  const { text } = learningsForPrompt(
    opts.workspaceDir,
    opts.taskKey ? { taskKey: opts.taskKey } : {},
    opts.env ?? process.env
  );
  return { text };
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
  // A caller may inject a trusted policy (issue P32) — used verbatim so a P32
  // review pins the operator's policy instead of the PR head's contributor copy.
  const policy = opts.safetyPolicy ?? readSafetyPolicy(workspaceDir);

  return withRetries(
    async () => {
      // Fresh per attempt: a retried render (flaky shell tag) re-reports its
      // violations + compressions, so the surviving attempt's evidence is what
      // gets recorded.
      const violations: PolicyViolation[] = [];
      const toolsUsed: ToolUsage[] = [];
      const compressSpill =
        opts.compressor && opts.retrievalStore
          ? (name: string, content: string): string => {
              const category = spillCategory(name);
              // Selective by lifecycle (issue #200): only retrievable-class
              // spills are compressed; the diff under review stays verbatim.
              if (!isCompressibleCategory(category)) return content;
              const out = compressContentSync(
                opts.compressor!,
                {
                  key: `${iteration}-${label}-${name}`,
                  category,
                  text: content,
                },
                opts.retrievalStore ?? null
              );
              toolsUsed.push(compressionToolUsage(out, category, stage.name));
              return out.text;
            }
          : undefined;
      // P29: the harness owns the `<learnings>` block. Default `{{ LEARNINGS }}`
      // here — the single renderTemplate call site, so this one seam covers the
      // loop, panel substages, and fan-out. An explicit caller-supplied var
      // still wins, which is what lets tests render templates in isolation.
      const renderVars =
        vars.LEARNINGS === undefined
          ? {
              ...vars,
              LEARNINGS: prepareLearnings({
                workspaceDir,
                ...(vars.TASK_KEY ? { taskKey: vars.TASK_KEY } : {}),
                ...(opts.childEnv ? { env: opts.childEnv } : {}),
              }).text,
            }
          : vars;
      let prompt = renderTemplate(
        join(packageDir, "templates", stage.template),
        renderVars,
        {
          cwd: workspaceDir,
          spillHostDir,
          spillRefPath,
          policy,
          onPolicyViolation: (v) => violations.push(v),
          ...(compressSpill ? { compressSpill } : {}),
        }
      );
      if (tokenMode === "reduce") {
        const reduced = applyPromptReduction(prompt);
        prompt = reduced.prompt;
        const {
          originalChars,
          reducedChars,
          whitespaceSavedChars,
          commitsSavedChars,
        } = reduced.stats;
        // Report the levers that actually ran. The old line printed a "cache
        // hits" figure this module never measured (it was hardcoded 0).
        const levers = [
          commitsSavedChars > 0 ? `commits -${commitsSavedChars}` : null,
          whitespaceSavedChars > 0
            ? `whitespace -${whitespaceSavedChars}`
            : null,
        ]
          .filter(Boolean)
          .join(", ");
        process.stderr.write(
          `${dim(`prompt reduce ${originalChars} -> ${reducedChars} chars${levers ? ` | ${levers}` : ""}`)}\n`
        );
      }
      // Append the bounded, attributed skill block (issue #114 P18) after
      // rendering + reduction so it reaches the agent verbatim and is measured by
      // analyzeContext below. Empty ⇒ no change to the rendered prompt.
      if (opts.injectedContext && opts.injectedContext.trim().length > 0) {
        prompt = `${prompt}\n\n${opts.injectedContext}\n`;
      }
      // Route the model for this stage (issue #66 P11): a pin wins, else the
      // declared tier through the ladder when routing is on, else runtime default.
      const model = resolveStageModel({
        runtimeId: opts.agentId ?? DEFAULT_AGENT,
        stage,
        routing: opts.modelRouting === true,
        ladder: opts.tierLadder ?? EMPTY_LADDER,
        assessment: opts.riskAssessment,
        escalations: opts.escalations,
      });
      const result = await runStage(
        stage,
        prompt,
        workspaceDir,
        iteration,
        spillHostDir,
        stageLog,
        {
          signal,
          runtime,
          sink: opts.sink,
          modelSpec: model.spec,
          sandboxWriteRoots: opts.sandboxWriteRoots,
          childEnv: opts.childEnv,
        }
      );
      // Attribute the *final* prompt's window footprint by category (issue #62
      // P7). `prompt` is post-reduction, so the breakdown reflects what was sent.
      return {
        ...result,
        logPath: relative(workspaceDir, stageLog),
        contextBreakdown: analyzeContext(prompt),
        ...(model.tier
          ? {
              routedTier: model.tier,
              routedModel: model.spec,
              modelSource: model.source,
            }
          : {}),
        ...(violations.length > 0
          ? { safetyEvents: violations.map(violationToSafetyEvent) }
          : {}),
        ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
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
