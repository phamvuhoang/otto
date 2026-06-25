import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, posix } from "node:path";

import { AGENT_DISPLAY_NAMES, type AgentRuntimeId } from "./agent-runtime.js";
import { resolveModelSelection } from "./model-tier.js";
import type { ContextBreakdown } from "./context-report.js";
import type { SafetyEvent, SkillUsage, ToolUsage } from "./run-report.js";
import type { Stage } from "./stages.js";
import { boldOut, dim, SYM_OUT, type StreamJson } from "./stream-render.js";
import { VerboseSink, type EventSink } from "./console-ui.js";
import {
  RateLimitError,
  isLimitResult,
  resetsAtFromEvent,
} from "./rate-limit.js";
import { emptyTokenUsage, parseTokenUsage, type TokenUsage } from "./tokens.js";

export type RunStageOptions = {
  signal?: AbortSignal;
  /** Agent runtime to drive the stage with; defaults to the Claude adapter. */
  runtime?: AgentRuntime;
  /** In-run console sink (issue #65 P10). Absent → a fresh VerboseSink, so a
   *  sink-less run renders exactly as before. */
  sink?: EventSink;
  /** Per-stage model spec (issue #66 P11). When set, overrides the env-based
   *  resolveModelSelection — the caller (executeStage) has already applied the
   *  pin > route > default precedence. Absent ⇒ today's env-based resolution. */
  modelSpec?: string;
  /** Extra sandbox write roots beyond the workspace (issue #66 P11). A fan-out
   *  sub-agent passes its parent repo so it can commit from its worktree (whose
   *  shared `.git` lives outside the worktree dir). Sandbox runner only. */
  sandboxWriteRoots?: string[];
};

export type StageResult = {
  result: string;
  costUsd: number;
  isError: boolean;
  apiErrorStatus: string | null;
  usage: TokenUsage;
  /** Workspace-relative NDJSON log path for this stage, when known. */
  logPath?: string;
  /** The agent runtime that produced this result (Claude's stream-json shape today). */
  runtimeId: AgentRuntimeId;
  /** Safety events emitted while rendering/running this stage (issue #43 P4);
   *  absent when none — e.g. a policy violation blocked at a shell/@spill tag. */
  safetyEvents?: SafetyEvent[];
  /** Composition of the rendered prompt that drove this stage (issue #62 P7);
   *  attributed by `analyzeContext` in `stage-exec.ts`, absent when not measured. */
  contextBreakdown?: ContextBreakdown;
  /** External tools invoked while rendering/running this stage (issue #111 P19);
   *  today only the P20 context compressor at @spill — absent when none ran. */
  toolsUsed?: ToolUsage[];
  /** Validated skills injected into this stage's prompt (issue #114 P18); set by
   *  the loop after routing when `--use-skills` is active — absent when none. */
  skillsUsed?: SkillUsage[];
  /** Model tier this stage was routed to (issue #66 P11); absent when routing
   *  off or the stage has no declared tier. */
  routedTier?: import("./model-tier.js").ModelTier;
  /** Concrete model spec the routed tier resolved to (undefined ⇒ runtime default). */
  routedModel?: string;
  /** Where the model came from: "pin" | "route" | "default". */
  modelSource?: string;
};

/**
 * Pure extraction of the fields Otto tracks from a stream-json `result` event.
 * `runtimeId` stamps which runtime produced it (defaults to claude — the only
 * runtime whose output is this stream-json shape today).
 */
export function resultFromEvent(
  ev: unknown,
  runtimeId: AgentRuntimeId = "claude"
): StageResult {
  const e = (ev ?? {}) as Record<string, unknown>;
  return {
    result: typeof e.result === "string" ? e.result : "",
    costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0,
    isError: e.is_error === true,
    apiErrorStatus:
      typeof e.api_error_status === "string" ? e.api_error_status : null,
    usage: parseTokenUsage(e),
    runtimeId,
  };
}

function usageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function codexUsageFromEvent(ev: unknown): TokenUsage {
  const e = (ev ?? {}) as Record<string, unknown>;
  const u = (e.usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: usageNumber(u.input_tokens),
    outputTokens: usageNumber(u.output_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usageNumber(u.cached_input_tokens),
  };
}

function codexErrorMessage(ev: unknown): string | null {
  const e = (ev ?? {}) as Record<string, unknown>;
  const err = (e.error ?? {}) as Record<string, unknown>;
  if (typeof err.message === "string") return err.message;
  if (typeof e.message === "string") return e.message;
  return null;
}

function codexAgentMessage(ev: unknown): string | null {
  const e = (ev ?? {}) as Record<string, unknown>;
  if (e.type !== "item.completed") return null;
  const item = (e.item ?? {}) as Record<string, unknown>;
  if (typeof item.text !== "string") return null;
  return item.type === "agent_message" || typeof item.text === "string"
    ? item.text
    : null;
}

function renderCodexEvent(ev: unknown): void {
  const text = codexAgentMessage(ev);
  if (text == null) return;
  const lines = text.split("\n");
  const formatted = lines
    .map((line, idx) =>
      idx === 0 ? `${boldOut(SYM_OUT.bullet)} ${line}` : `  ${line}`
    )
    .join("\r\n");
  process.stdout.write(formatted + "\r\n\n");
}

export type CodexStreamParser = (ev: unknown) => StageResult | undefined;

/**
 * Create a per-run parser for `codex exec --json` JSONL. Codex reports the
 * final assistant text as the last `item.completed` agent_message and emits the
 * terminal status on `turn.completed` / `turn.failed` / `error`.
 */
export function createCodexStreamParser(): CodexStreamParser {
  let result = "";
  let usage = emptyTokenUsage();
  let isError = false;
  let apiErrorStatus: string | null = null;

  const finish = (): StageResult => ({
    result,
    costUsd: 0,
    isError,
    apiErrorStatus,
    usage,
    runtimeId: "codex",
  });

  return (ev: unknown): StageResult | undefined => {
    const e = (ev ?? {}) as Record<string, unknown>;
    const type = e.type;

    const text = codexAgentMessage(ev);
    if (text != null) {
      result = text;
      return undefined;
    }

    if (type === "turn.completed") {
      usage = codexUsageFromEvent(ev);
      return finish();
    }

    if (type === "turn.failed" || type === "error") {
      isError = true;
      const msg = codexErrorMessage(ev);
      if (msg) {
        apiErrorStatus = msg;
        if (!result) result = msg;
      }
      return finish();
    }

    return undefined;
  };
}

function numericUnixSeconds(value: number): number {
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

function valueFromObject(
  obj: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

/**
 * Opportunistically read a Codex reset hint from failed-turn/error events. The
 * CLI does not currently promise a single stable reset field, so absent or
 * unknown shapes return null and the loop falls back to its default wait.
 */
export function resetsAtFromCodexEvent(
  ev: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): number | null {
  const e = (ev ?? {}) as Record<string, unknown>;
  if (e.type !== "turn.failed" && e.type !== "error") return null;
  const err = (e.error ?? e ?? {}) as Record<string, unknown>;
  const rateLimits = (err.rate_limits ?? e.rate_limits) as
    | Record<string, unknown>
    | undefined;

  const seconds = valueFromObject(err, [
    "resets_in_seconds",
    "reset_in_seconds",
    "retry_after_seconds",
  ]);
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    return nowSeconds + Math.floor(seconds);
  }

  const retryAfterMs = valueFromObject(err, ["retry_after_ms"]);
  if (
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return nowSeconds + Math.ceil(retryAfterMs / 1000);
  }

  const resetAt =
    valueFromObject(err, ["resets_at", "reset_at", "resetsAt"]) ??
    (rateLimits
      ? valueFromObject(rateLimits, ["resets_at", "reset_at", "resetsAt"])
      : undefined);
  if (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt >= 0) {
    return numericUnixSeconds(resetAt);
  }
  if (typeof resetAt === "string") {
    const parsed = Date.parse(resetAt);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }

  return null;
}

const STDERR_TAIL_LINES = 40;
const DEFAULT_RESULT_GRACE_MS = 30_000;

/**
 * Parse `OTTO_RESULT_GRACE_MS`. Returns the configured millisecond budget,
 * `0` to disable the timer entirely, or `defaultMs` for any invalid input
 * (unset, empty, non-finite, negative).
 */
export function parseGraceMs(
  raw: string | undefined,
  defaultMs: number = DEFAULT_RESULT_GRACE_MS
): number {
  if (raw == null) return defaultMs;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultMs;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return defaultMs;
  if (n < 0) return defaultMs;
  return Math.floor(n);
}

/**
 * Resolve `OTTO_MODEL` into a `claude` argv fragment. Returns
 * `["--model", trimmed]` for a non-empty value, or `[]` for unset / empty /
 * whitespace-only input. Pass-through: otto never validates the model spec,
 * the `claude` CLI owns that.
 */
export function resolveModelArgs(raw: string | undefined): string[] {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return ["--model", trimmed];
}

// Re-exported for back-compat: `resolveModelSelection` moved to model-tier.ts
// (issue #66 P11) to decouple the pin check from this mocked module, but
// existing importers (cli-help.ts, runner.test.ts) still reach it here.
export { resolveModelSelection };

export type Runner = "sandbox" | "host";

/** `OTTO_RUNNER=host` → bare host run; anything else (incl. unset) → sandbox. */
export function resolveRunner(raw: string | undefined): Runner {
  return raw?.trim() === "host" ? "host" : "sandbox";
}

/** Parse `OTTO_SANDBOX_NET` into a domain allowlist. Empty = unrestricted. */
export function resolveSandboxNet(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Go-based CLIs fail TLS verification under macOS Seatbelt; run them outside the
// sandbox so `gh`/`gcloud`/`terraform` keep working (otto-ghafk relies on gh).
const SANDBOX_EXCLUDED_COMMANDS = ["gh *", "gcloud *", "terraform *"];

/**
 * Claude Code native-sandbox settings: confine writes to the workspace and run
 * the Go-TLS CLIs unsandboxed. When `allowedDomains` is non-empty, also restrict
 * network egress to that list; otherwise leave network unrestricted (filesystem
 * is the blast-radius control; network commands fall back to the bypass-approved
 * escape hatch).
 */
export function buildSandboxSettings(
  workspaceDir: string,
  allowedDomains: string[],
  extraWriteRoots: string[] = []
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    enabled: true,
    // `extraWriteRoots` lets a fan-out sub-agent commit from a worktree whose
    // shared `.git` lives in the parent repo, outside the worktree dir (#66 P11).
    filesystem: { allowWrite: [workspaceDir, ...extraWriteRoots] },
    excludedCommands: SANDBOX_EXCLUDED_COMMANDS,
  };
  if (allowedDomains.length > 0) {
    sandbox.network = { allowedDomains };
  }
  return { sandbox };
}

function abortError(command: string): Error {
  const err = new Error(`${command} command aborted`);
  err.name = "AbortError";
  return err;
}

export function stageLogPath(
  workspaceDir: string,
  iteration: number,
  stageName: string,
  runtimeId?: AgentRuntimeId
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = runtimeId ? `-${runtimeId}` : "";
  return join(
    workspaceDir,
    ".otto-tmp",
    "logs",
    `${timestamp}-iter${iteration}-${stageName}${suffix}.ndjson`
  );
}

/**
 * Build the `claude` argv. Extracted as a pure helper so callers can unit-test
 * the argv without spawning a process.
 *
 * @param stage - The stage configuration (name, permissionMode, etc.).
 * @param promptRelPath - The workspace-relative path to the rendered prompt file.
 * @param modelArgs - The `["--model", "<spec>"]` fragment from {@link resolveModelArgs},
 *   or `[]` when `OTTO_MODEL` is unset.
 * @param settingsPath - Optional absolute path to a transient settings JSON file
 *   (written by `runStage` when `OTTO_RUNNER=sandbox`).
 * @returns The full argv starting with `"claude"` and ending with the prompt
 *   instruction string.
 */
export function buildClaudeArgs(
  stage: Stage,
  promptRelPath: string,
  modelArgs: string[],
  settingsPath?: string
): string[] {
  const args = [
    "claude",
    "--verbose",
    "--print",
    "--output-format",
    "stream-json",
  ];
  if (stage.permissionMode) {
    args.push("--permission-mode", stage.permissionMode);
  }
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  args.push(...modelArgs);
  args.push(
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`
  );
  return args;
}

export type CodexSandboxMode = "workspace-write" | "danger-full-access";

/** Map Otto's runner mode to Codex's own sandbox vocabulary. */
export function resolveCodexSandboxMode(
  raw: string | undefined
): CodexSandboxMode {
  return resolveRunner(raw) === "host"
    ? "danger-full-access"
    : "workspace-write";
}

/**
 * Build the `codex exec` argv. Codex owns sandboxing itself, so Otto never
 * passes Claude's transient `--settings` file here.
 *
 * Codex's `workspace-write` sandbox makes the repo's `.git/` read-only even
 * though it sits inside the writable workdir, so `git add`/`commit` fail with
 * `Unable to create .git/index.lock: Operation not permitted`. Otto's loop is
 * commit-driven — without writable `.git` the agent re-does the same uncommitted
 * work every iteration and the run spins to max rounds. Re-add `.git` (resolved
 * relative to the workdir Otto spawns Codex in) to Codex's writable roots.
 * Unnecessary under `danger-full-access`, which has no filesystem confinement.
 */
export function buildCodexArgs(
  _stage: Stage,
  promptRelPath: string,
  modelArgs: string[],
  _settingsPath?: string,
  sandboxMode: CodexSandboxMode = resolveCodexSandboxMode(
    process.env.OTTO_RUNNER
  )
): string[] {
  const gitWritableArgs =
    sandboxMode === "workspace-write"
      ? ["-c", 'sandbox_workspace_write.writable_roots=[".git"]']
      : [];
  return [
    "codex",
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    sandboxMode,
    ...gitWritableArgs,
    ...modelArgs,
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`,
  ];
}

/**
 * Codex's current CLI docs call out CODEX_API_KEY for `codex exec`; issue #31's
 * acceptance criteria also mention OPENAI_API_KEY. Preserve both by mapping the
 * OpenAI key into Codex's expected env var for this child process only.
 */
export function buildCodexEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  // Keep the compatibility mapping scoped to the child so Otto's own process
  // does not mutate the user's shell-level credential environment.
  if (!next.CODEX_API_KEY && next.OPENAI_API_KEY) {
    next.CODEX_API_KEY = next.OPENAI_API_KEY;
  }
  return next;
}

/**
 * Provider-neutral boundary between the loop and the agent CLI it drives
 * (issue #24 P0). Everything above this contract — stages, templates, retries,
 * logs, budget — is runtime-agnostic; everything Claude-specific (argv flags,
 * result-event shape) lives behind an adapter.
 */
export type AgentRuntime = {
  id: AgentRuntimeId;
  displayName: string;
  /** The CLI binary spawned (argv[0]); also used in log/error prefixes. */
  command: string;
  /** Whether the runtime accepts Otto's native-sandbox `--settings` file. */
  supportsSandboxSettings: boolean;
  /** Build the spawn argv for a stage (see {@link buildClaudeArgs}). */
  buildArgs(
    stage: Stage,
    promptRelPath: string,
    modelArgs: string[],
    settingsPath?: string
  ): string[];
  /** Map one final result event into a provider-neutral {@link StageResult}. */
  parseResultEvent(ev: unknown): StageResult;
  /** Optional per-run parser for runtimes whose final result spans events. */
  createStreamParser?: () => (ev: unknown) => StageResult | undefined;
  /** Optional runtime-specific reset-time extraction. */
  resetsAtFromEvent?: (ev: unknown) => number | null;
  /** Optional child env override. */
  buildEnv?: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

/** The Claude Code adapter — Otto's default and historically-hardcoded runtime. */
export const claudeRuntime: AgentRuntime = {
  id: "claude",
  displayName: AGENT_DISPLAY_NAMES.claude,
  command: "claude",
  supportsSandboxSettings: true,
  buildArgs: buildClaudeArgs,
  parseResultEvent: (ev) => resultFromEvent(ev, "claude"),
};

/** The Codex CLI adapter, powered by `codex exec --json`. */
export const codexRuntime: AgentRuntime = {
  id: "codex",
  displayName: AGENT_DISPLAY_NAMES.codex,
  command: "codex",
  supportsSandboxSettings: false,
  buildArgs: buildCodexArgs,
  parseResultEvent: (ev) => resultFromEvent(ev, "codex"),
  createStreamParser: createCodexStreamParser,
  resetsAtFromEvent: resetsAtFromCodexEvent,
  buildEnv: buildCodexEnv,
};

const AGENT_RUNTIMES: Partial<Record<AgentRuntimeId, AgentRuntime>> = {
  claude: claudeRuntime,
  codex: codexRuntime,
};

/**
 * Select the adapter for a resolved runtime id.
 */
export function getAgentRuntime(id: AgentRuntimeId): AgentRuntime {
  const runtime = AGENT_RUNTIMES[id];
  if (!runtime) {
    throw new Error(
      `the ${AGENT_DISPLAY_NAMES[id]} runtime is not available in this build.`
    );
  }
  return runtime;
}

export async function runStage(
  stage: Stage,
  renderedPrompt: string,
  workspaceDir: string,
  iteration: number,
  spillHostDir?: string,
  logPathOverride?: string,
  options: RunStageOptions = {}
): Promise<StageResult> {
  const tmpHostDir = join(workspaceDir, ".otto-tmp");
  mkdirSync(tmpHostDir, { recursive: true });

  const logsDir = join(tmpHostDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath =
    logPathOverride ?? stageLogPath(workspaceDir, iteration, stage.name);

  const promptName = `.run-${process.pid}-${iteration}-${Date.now()}.md`;
  const promptHostPath = join(tmpHostDir, promptName);
  const promptRelPath = posix.join(".otto-tmp", promptName);
  writeFileSync(promptHostPath, renderedPrompt, "utf8");

  const runtime = options.runtime ?? claudeRuntime;

  let settingsHostPath: string | undefined;
  if (
    runtime.supportsSandboxSettings &&
    resolveRunner(process.env.OTTO_RUNNER) === "sandbox"
  ) {
    const settings = buildSandboxSettings(
      workspaceDir,
      resolveSandboxNet(process.env.OTTO_SANDBOX_NET),
      options.sandboxWriteRoots ?? []
    );
    settingsHostPath = join(
      tmpHostDir,
      `.sandbox-${process.pid}-${iteration}-${Date.now()}.json`
    );
    writeFileSync(settingsHostPath, JSON.stringify(settings), "utf8");
  }

  process.stderr.write(`${dim("log → " + logPath)}\n`);

  try {
    const modelSpec =
      options.modelSpec ?? resolveModelSelection(runtime.id)?.spec;
    const argv = runtime.buildArgs(
      stage,
      promptRelPath,
      resolveModelArgs(modelSpec),
      settingsHostPath
    );
    return await streamRuntime(argv, workspaceDir, logPath, runtime, options);
  } finally {
    rmSync(promptHostPath, { force: true });
    if (settingsHostPath) rmSync(settingsHostPath, { force: true });
    if (spillHostDir) rmSync(spillHostDir, { recursive: true, force: true });
  }
}

function streamRuntime(
  argv: string[],
  cwd: string,
  logPath: string,
  runtime: AgentRuntime,
  options: RunStageOptions = {}
): Promise<StageResult> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError(runtime.command));
  }

  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");
    // Resolve the in-run console sink once. No sink → VerboseSink, so a run with
    // no sink renders exactly as before (issue #65 P10).
    const sink: EventSink = options.sink ?? new VerboseSink();
    const graceMs = parseGraceMs(process.env.OTTO_RESULT_GRACE_MS);
    const parseStreamEvent = runtime.createStreamParser?.();

    const settleFinalAfterGrace = (): void => {
      // Arm one-shot post-result grace timer to recover from CLI self-deadlocks
      // where the child emits its final NDJSON but never exits.
      if (graceTimer || graceMs <= 0) return;
      graceTimer = setTimeout(() => {
        if (settled) return;
        process.stderr.write(
          `${dim(`grace timer fired after ${graceMs}ms post-result — killing ${runtime.command} child`)}\n`
        );
        try {
          child.kill();
        } catch {
          // Already dead; close handler will be a no-op via settle guard.
        }
        if (final && isLimitResult(final)) {
          rejectOnce(
            new RateLimitError(final.result || "rate limit", lastResetsAt)
          );
        } else {
          resolveOnce(final);
        }
      }, graceMs);
      graceTimer.unref?.();
    };

    // Spawn the selected agent CLI on the host instead of docker.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: runtime.buildEnv?.(process.env) ?? process.env,
    });

    let final: StageResult = {
      result: "",
      costUsd: 0,
      isError: false,
      apiErrorStatus: null,
      usage: emptyTokenUsage(),
      runtimeId: runtime.id,
    };
    let lastResetsAt: number | null = null;
    const stderrTail: string[] = [];
    let settled = false;
    let onAbort = (): void => {};
    let rl: ReturnType<typeof createInterface> | undefined;
    let rlErr: ReturnType<typeof createInterface> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
      try {
        rl?.close();
      } catch {
        // Already closed.
      }
      try {
        rlErr?.close();
      } catch {
        // Already closed.
      }
      try {
        closeSync(logFd);
      } catch {
        // Already closed.
      }
      fn();
    };

    const rejectOnce = (err: unknown): void => finish(() => reject(err));
    const resolveOnce = (value: StageResult): void =>
      finish(() => resolve(value));

    onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // Already dead; close handling below will settle if needed.
      }
      rejectOnce(abortError(runtime.command));
    };

    rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (settled) return;
      if (!line.startsWith("{")) return;

      appendFileSync(logFd, line + "\n");

      let parsed: StreamJson;
      try {
        parsed = JSON.parse(line) as StreamJson;
      } catch {
        return;
      }
      if (runtime.id === "codex") renderCodexEvent(parsed);
      else sink.onEvent(parsed);

      const runtimeReset = runtime.resetsAtFromEvent?.(parsed);
      if (runtimeReset != null) lastResetsAt = runtimeReset;
      else if (parsed.type === "rate_limit_event") {
        const claudeReset = resetsAtFromEvent(parsed);
        if (claudeReset != null) lastResetsAt = claudeReset;
      }

      const streamResult = parseStreamEvent?.(parsed);
      if (streamResult) {
        final = streamResult;
        settleFinalAfterGrace();
      } else if (parsed.type === "result") {
        final = runtime.parseResultEvent(parsed);
        settleFinalAfterGrace();
      }
    });

    rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (settled) return;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      process.stderr.write(`${dim(runtime.command + "  " + line)}\n`);
    });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      rejectOnce(err);
    });
    child.on("close", (code) => {
      if (final && isLimitResult(final)) {
        rejectOnce(
          new RateLimitError(final.result || "rate limit", lastResetsAt)
        );
        return;
      }
      if (code !== 0) {
        rejectOnce(
          new Error(
            `${runtime.command} exited with ${code}\n${stderrTail.join("\n")}`
          )
        );
        return;
      }
      resolveOnce(final);
    });
  });
}
