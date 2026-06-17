import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent CLI Otto drives a stage with. `claude` is the only runtime that is
 * currently runnable end-to-end; `codex` is a known id (so its selection is
 * visible in --print-config) whose adapter lands in a later issue-24 slice.
 */
export type AgentRuntimeId = "claude" | "codex";

/** Where the resolved runtime came from, for --print-config transparency. */
export type AgentSelectionSource = "default" | "flag" | "env" | "config";

export const DEFAULT_AGENT: AgentRuntimeId = "claude";

export const AGENT_DISPLAY_NAMES: Record<AgentRuntimeId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
};

export type ResolvedAgentRuntime = {
  id: AgentRuntimeId;
  displayName: string;
  source: AgentSelectionSource;
};

const CONFIG_REL = join(".otto", "config.json");

/**
 * Validate a raw agent id against the known runtimes. Throws a clean one-line
 * error (no stack-relevant context) on anything else; `source` names where the
 * value came from (`--agent`, `OTTO_AGENT`, `.otto/config.json "agent"`).
 */
export function parseAgentId(raw: string, source: string): AgentRuntimeId {
  const trimmed = raw.trim();
  if (trimmed === "claude" || trimmed === "codex") {
    return trimmed;
  }
  throw new Error(
    `${source} must be one of claude|codex, got: ${JSON.stringify(raw)}`
  );
}

/**
 * Resolve the active runtime by precedence: flag → env → config → default. The
 * `flag` is already validated (parseFlags ran parseAgentId); `env`/`config` are
 * raw and validated here, throwing on an invalid value so the caller can report
 * it (mirrors the OTTO_TOKEN_MODE handling in run-bin). Blank env/config is
 * skipped, not an error.
 */
export function resolveAgentRuntime(opts: {
  flag?: AgentRuntimeId;
  env?: string;
  config?: string;
}): ResolvedAgentRuntime {
  const mk = (
    id: AgentRuntimeId,
    source: AgentSelectionSource
  ): ResolvedAgentRuntime => ({
    id,
    displayName: AGENT_DISPLAY_NAMES[id],
    source,
  });

  if (opts.flag) return mk(opts.flag, "flag");
  const envRaw = opts.env?.trim();
  if (envRaw) return mk(parseAgentId(envRaw, "OTTO_AGENT"), "env");
  const cfgRaw = opts.config?.trim();
  if (cfgRaw) return mk(parseAgentId(cfgRaw, '.otto/config.json "agent"'), "config");
  return mk(DEFAULT_AGENT, "default");
}

/** Fallback-on-limit selection: the runtime to switch to + whether to do so. */
export type ResolvedFallback = {
  /**
   * The fallback runtime + where it was selected from, or undefined when no
   * fallback agent is configured (the default — fallback is OFF).
   */
  agent?: ResolvedAgentRuntime;
  /** Whether auto-switch-on-limit is enabled (default false). */
  autoSwitch: boolean;
};

/** Env strings counted as "on" for a boolean toggle; anything else is off. */
function isTruthyEnv(raw: string): boolean {
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Resolve fallback-on-limit config. The fallback runtime follows the same
 * flag → env → config precedence as the primary agent but has NO default (unset
 * = no fallback); auto-switch is a boolean with flag → env → config → false
 * precedence. Both default OFF — switching providers changes model behavior and
 * must be explicit. Blank env/config is skipped, not an error; an invalid
 * fallback-agent env/config value throws so the caller can report it (mirrors
 * resolveAgentRuntime). This run resolves config only; the actual switch lands
 * in a later issue-24 slice.
 */
export function resolveFallback(opts: {
  flagAgent?: AgentRuntimeId;
  envAgent?: string;
  configAgent?: string;
  flagAutoSwitch?: boolean;
  envAutoSwitch?: string;
  configAutoSwitch?: boolean;
}): ResolvedFallback {
  const mk = (
    id: AgentRuntimeId,
    source: AgentSelectionSource
  ): ResolvedAgentRuntime => ({
    id,
    displayName: AGENT_DISPLAY_NAMES[id],
    source,
  });

  let agent: ResolvedAgentRuntime | undefined;
  if (opts.flagAgent) {
    agent = mk(opts.flagAgent, "flag");
  } else {
    const envRaw = opts.envAgent?.trim();
    const cfgRaw = opts.configAgent?.trim();
    if (envRaw) agent = mk(parseAgentId(envRaw, "OTTO_FALLBACK_AGENT"), "env");
    else if (cfgRaw)
      agent = mk(parseAgentId(cfgRaw, '.otto/config.json "fallbackAgent"'), "config");
  }

  let autoSwitch = false;
  const envSwitch = opts.envAutoSwitch?.trim();
  if (opts.flagAutoSwitch) autoSwitch = true;
  else if (envSwitch) autoSwitch = isTruthyEnv(envSwitch);
  else if (opts.configAutoSwitch != null) autoSwitch = opts.configAutoSwitch;

  return agent ? { agent, autoSwitch } : { autoSwitch };
}

/**
 * Read the fallback-on-limit fields from `.otto/config.json`: `fallbackAgent`
 * (string, validated later in resolveFallback) and `autoSwitchOnLimit` (boolean).
 * Wrong-typed or absent values are dropped; never throws. Kept separate from
 * readAgentConfig/readBranchConfig, matching the one-reader-per-concern pattern.
 */
export function readFallbackConfig(workspaceDir: string): {
  agent?: string;
  autoSwitch?: boolean;
} {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, CONFIG_REL), "utf8")
    ) as Record<string, unknown>;
    const out: { agent?: string; autoSwitch?: boolean } = {};
    if (typeof raw.fallbackAgent === "string") out.agent = raw.fallbackAgent;
    if (typeof raw.autoSwitchOnLimit === "boolean")
      out.autoSwitch = raw.autoSwitchOnLimit;
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the raw `agent` field from `.otto/config.json`. Returns the string as-is
 * (validation happens in resolveAgentRuntime); absent, malformed, or non-string
 * → undefined. Never throws. Kept separate from readBranchConfig so the agent
 * config stays decoupled from branch config.
 */
export function readAgentConfig(workspaceDir: string): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, CONFIG_REL), "utf8")
    ) as Record<string, unknown>;
    return typeof raw.agent === "string" ? raw.agent : undefined;
  } catch {
    return undefined;
  }
}
