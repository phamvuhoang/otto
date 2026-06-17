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
import type { Stage } from "./stages.js";
import {
  dim,
  renderEvent,
  type StreamJson,
  type ToolTrack,
} from "./stream-render.js";
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
};

export type StageResult = {
  result: string;
  costUsd: number;
  isError: boolean;
  apiErrorStatus: string | null;
  usage: TokenUsage;
  /** The agent runtime that produced this result (Claude's stream-json shape today). */
  runtimeId: AgentRuntimeId;
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
  allowedDomains: string[]
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    enabled: true,
    filesystem: { allowWrite: [workspaceDir] },
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

/**
 * Provider-neutral boundary between the loop and the agent CLI it drives
 * (issue #24 P0). Everything above this contract — stages, templates, retries,
 * logs, budget — is runtime-agnostic; everything Claude-specific (argv flags,
 * result-event shape) lives behind an adapter. Claude is the only implemented
 * runtime today; Codex's adapter lands in a later slice.
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

const AGENT_RUNTIMES: Partial<Record<AgentRuntimeId, AgentRuntime>> = {
  claude: claudeRuntime,
};

/**
 * Select the adapter for a resolved runtime id. Only `claude` is implemented;
 * `codex` throws a clean "not implemented" error (real codex runs are already
 * blocked upstream in run-bin, so this is a defensive backstop with a
 * consistent message).
 */
export function getAgentRuntime(id: AgentRuntimeId): AgentRuntime {
  const runtime = AGENT_RUNTIMES[id];
  if (!runtime) {
    throw new Error(
      `the ${AGENT_DISPLAY_NAMES[id]} runtime is not implemented yet; only Claude Code is currently runnable (see issue #24).`
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
      resolveSandboxNet(process.env.OTTO_SANDBOX_NET)
    );
    settingsHostPath = join(
      tmpHostDir,
      `.sandbox-${process.pid}-${iteration}-${Date.now()}.json`
    );
    writeFileSync(settingsHostPath, JSON.stringify(settings), "utf8");
  }

  process.stderr.write(`${dim("log → " + logPath)}\n`);

  try {
    const argv = runtime.buildArgs(
      stage,
      promptRelPath,
      resolveModelArgs(process.env.OTTO_MODEL),
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
    const toolMap = new Map<string, ToolTrack>();
    const graceMs = parseGraceMs(process.env.OTTO_RESULT_GRACE_MS);

    // Spawn claude (argv[0]) on the host instead of docker.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
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
      renderEvent(parsed, toolMap);
      if (parsed.type === "rate_limit_event") {
        const r = resetsAtFromEvent(parsed);
        if (r != null) lastResetsAt = r;
      }
      if (parsed.type === "result") {
        final = runtime.parseResultEvent(parsed);
        // Arm one-shot post-result grace timer to recover from claude-CLI
        // self-deadlocks where the child emits its final NDJSON but never
        // exits. See docs/prd/result-grace-timer.md.
        if (!graceTimer && graceMs > 0) {
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
        }
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
