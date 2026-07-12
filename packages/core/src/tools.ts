import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_POLICY,
  checkCommand,
  checkNetworkDomain,
  checkWritePath,
  type PolicyViolation,
  type SafetyPolicy,
} from "./safety-policy.js";
import type { SafetyEvent } from "./run-report.js";

/**
 * External tool authority layer (issue #111 P19). Otto exposes external tools —
 * local services, MCP servers, HTTP/proxy adapters, SDK shims — to stages only
 * through a typed, repo-local registry under `.otto/tools/<name>.json`, governed
 * by `.otto/policy.json`. A tool is a *declared capability with scope*: which
 * stages may use it, which commands/domains/write-roots/secrets it touches, and
 * how to health-check it. Authority is the INTERSECTION of the tool's declared
 * scope and the repo safety policy — a tool can only narrow, never widen, what a
 * run may do.
 *
 * Pure fs + JSON with safe defaults (absent/malformed → no tools, never throws),
 * mirroring `skills.ts`/`safety-policy.ts`. **Substrate, inert on the loop**: the
 * registry, contract, authorization predicate, and `ToolUsage` evidence type
 * exist and are exercised by the read-only `otto-tools` bin, but no stage invokes
 * a tool this slice — the first consumer is the P20 Headroom adapter. A workspace
 * with no `.otto/tools/` behaves exactly as today.
 *
 * **AFK invariant:** authority comes ONLY from this repo-local registry. Personal
 * MCP/plugin config (Claude/Codex user config) is never inherited into a run —
 * it is not reproducible and not repo-governed.
 */

/** Transport kind an adapter speaks. */
export type ToolKind = "command" | "mcp" | "http" | "proxy" | "sdk";

const TOOL_KINDS: ReadonlySet<string> = new Set([
  "command",
  "mcp",
  "http",
  "proxy",
  "sdk",
]);

/**
 * One tool's adapter contract, stored as `.otto/tools/<name>.json`. Every scope
 * field defaults to the most restrictive sensible value: `stages: []` means "no
 * stage" (a tool must opt INTO stages), while the network/write/secret lists
 * empty mean "touches none of that axis".
 */
export type ToolDefinition = {
  /** Filesystem-safe registry key; also the `<name>.json` basename. */
  name: string;
  kind: ToolKind;
  description?: string;
  /** Capability tags (a selection/`why` key). */
  capabilities: string[];
  /** Stage names this tool may run in; empty = none (opt-in required). */
  stages: string[];
  /** command/proxy: the executable + args template. */
  command?: string;
  /** Env var NAMES the adapter reads (values come from the host env, never inlined). */
  env: string[];
  /** Network domains the tool may reach — checked against policy + this list. */
  networkDomains: string[];
  /** Workspace-relative roots the tool may write — checked against policy + this list. */
  writeRoots: string[];
  /** Secret env-var names the tool needs; surfaced for audit, never inlined. */
  secretRefs: string[];
  /** Per-invocation timeout (ms); absent = adapter default. */
  timeoutMs?: number;
  /** Shell command that exits 0 when the tool is available/healthy. */
  healthCheck?: string;
  /** High-risk action names that require approval (joined with policy). */
  approvalActions: string[];
  /** Registry-level enable flag; config can additionally disable per stage. */
  enabled: boolean;
  /** Per-operation allowlist (issue #P26); absent = no op gating (today's behavior). */
  operations?: ToolOperation[];
};

/** One MCP-style operation a tool exposes, and whether it writes. */
export type ToolOperation = { name: string; write: boolean };

/**
 * The structured result an adapter returns (issue #111 output contract). Beyond
 * the payload it carries the levers Otto's evidence model needs: estimated token
 * savings (for compressors like Headroom), any safety events the invocation
 * raised, and a durable retrieval handle when the output is a reversible
 * transform of original content.
 */
export type ToolResult = {
  ok: boolean;
  output?: unknown;
  /** Estimated tokens saved (compression adapters); absent = not applicable. */
  tokensSaved?: number;
  safetyEvents?: SafetyEvent[];
  /** Durable handle to retrieve the original/reversible content; absent = none. */
  retrievalHandle?: string;
};

/** Per-tool override read from `.otto/config.json`'s `tools` block. */
export type ToolOverride = { enabled?: boolean; stages?: string[] };

/** The `tools` block of `.otto/config.json`: per-tool enable/stage overrides. */
export type ToolConfig = { overrides: Record<string, ToolOverride> };

const TOOLS_REL = join(".otto", "tools");

/** Absolute path to the tools registry root (`.otto/tools`). */
export function toolsDir(workspaceDir: string): string {
  return join(workspaceDir, TOOLS_REL);
}

/** Absolute path to one tool's definition (`.otto/tools/<name>.json`). */
export function toolPath(workspaceDir: string, name: string): string {
  return join(toolsDir(workspaceDir), `${name}.json`);
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
}

/**
 * Normalize an untrusted parsed `<name>.json` into a {@link ToolDefinition},
 * filling restrictive defaults. Returns null when it lacks a `name` (so a
 * malformed file is skipped, not crashed on). `kind` defaults to `command`;
 * `enabled` defaults to true; every scope list defaults to empty.
 */
export function parseTool(raw: unknown): ToolDefinition | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  const tool: ToolDefinition = {
    name: o.name,
    kind:
      typeof o.kind === "string" && TOOL_KINDS.has(o.kind)
        ? (o.kind as ToolKind)
        : "command",
    capabilities: stringArray(o.capabilities),
    stages: stringArray(o.stages),
    env: stringArray(o.env),
    networkDomains: stringArray(o.networkDomains),
    writeRoots: stringArray(o.writeRoots),
    secretRefs: stringArray(o.secretRefs),
    approvalActions: stringArray(o.approvalActions),
    enabled: o.enabled !== false,
  };
  if (typeof o.description === "string") tool.description = o.description;
  if (typeof o.command === "string") tool.command = o.command;
  if (typeof o.healthCheck === "string") tool.healthCheck = o.healthCheck;
  if (typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs)) {
    tool.timeoutMs = o.timeoutMs;
  }
  if (Array.isArray(o.operations)) {
    tool.operations = o.operations
      .filter(
        (op): op is Record<string, unknown> =>
          op !== null &&
          typeof op === "object" &&
          typeof (op as Record<string, unknown>).name === "string"
      )
      .map((op) => ({ name: op.name as string, write: op.write === true }));
  }
  return tool;
}

/**
 * Read every tool definition under `.otto/tools/` (the `*.json` files), skipping
 * malformed ones, sorted by name. Absent/unreadable dir → `[]` (never throws).
 * Reads ONLY the repo-local registry — personal MCP/plugin config is never
 * consulted (the AFK invariant).
 */
export function readTools(workspaceDir: string): ToolDefinition[] {
  let names: string[];
  try {
    names = readdirSync(toolsDir(workspaceDir))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const tools: ToolDefinition[] = [];
  for (const file of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(toolsDir(workspaceDir), file), "utf8")
      );
    } catch {
      continue;
    }
    const t = parseTool(parsed);
    if (t) tools.push(t);
  }
  return tools;
}

/**
 * Read the `tools` block of `.otto/config.json` (per-tool enable/stage
 * overrides). Absent/malformed file or block → no overrides (never throws). Only
 * the `tools` key is read; sibling config blocks (journal, branch) are untouched.
 */
export function readToolConfig(workspaceDir: string): ToolConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
  } catch {
    return { overrides: {} };
  }
  const block = raw.tools;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { overrides: {} };
  }
  const overrides: Record<string, ToolOverride> = {};
  for (const [name, v] of Object.entries(block as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const ov = v as Record<string, unknown>;
    const out: ToolOverride = {};
    if (typeof ov.enabled === "boolean") out.enabled = ov.enabled;
    if (Array.isArray(ov.stages)) out.stages = stringArray(ov.stages);
    overrides[name] = out;
  }
  return { overrides };
}

/** Whether a tool is enabled for `stage`, plus a human reason. Pure. */
export function toolEnabledForStage(
  tool: ToolDefinition,
  config: ToolConfig,
  stage: string
): { enabled: boolean; reason: string } {
  const ov = config.overrides[tool.name];
  const enabled = ov?.enabled ?? tool.enabled;
  if (!enabled) {
    return { enabled: false, reason: "disabled in registry/config" };
  }
  const stages = ov?.stages ?? tool.stages;
  if (stages.length === 0) {
    return { enabled: false, reason: "no stage allowlist (opt-in required)" };
  }
  if (!stages.includes(stage)) {
    return {
      enabled: false,
      reason: `stage "${stage}" not in allowlist [${stages.join(", ")}]`,
    };
  }
  return { enabled: true, reason: `enabled for stage "${stage}"` };
}

/** One tool's availability verdict for a stage (the `why` surface). */
export type ToolSelection = {
  name: string;
  kind: ToolKind;
  enabled: boolean;
  reason: string;
  capabilities: string[];
};

/**
 * Rank tools for a stage: enabled-first, then name. Disabled tools are still
 * returned (flagged, with the reason) so `otto-tools why <stage>` shows the full
 * picture — including a tool that exists but is policy/stage-gated off. Pure.
 */
export function selectToolsForStage(
  tools: ToolDefinition[],
  config: ToolConfig,
  stage: string
): ToolSelection[] {
  return tools
    .map((tool) => {
      const { enabled, reason } = toolEnabledForStage(tool, config, stage);
      return {
        name: tool.name,
        kind: tool.kind,
        enabled,
        reason,
        capabilities: tool.capabilities,
      };
    })
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)
    );
}

/** A concrete tool action to authorize before it runs. */
export type ToolInvocation = {
  /** Resolved shell command, if the adapter shells out. */
  command?: string;
  /** Domains the invocation would reach. */
  domains?: string[];
  /** Workspace-relative paths the invocation would write. */
  writePaths?: string[];
  /** Named high-risk action (matched against approval lists). */
  action?: string;
};

/** The authority verdict for a {@link ToolInvocation}. */
export type ToolAuthorization = {
  allowed: boolean;
  violations: PolicyViolation[];
  /** One blocked `policy-violation` {@link SafetyEvent} per violation. */
  events: SafetyEvent[];
};

/** A single-axis allow-list policy, to reuse the safety-policy predicates. */
function scopedPolicy(
  field: keyof SafetyPolicy,
  values: string[]
): SafetyPolicy {
  return { ...DEFAULT_POLICY, [field]: values };
}

/**
 * Authorize a tool invocation. Authority is the INTERSECTION of the repo safety
 * policy and the tool's declared scope, so a tool can only narrow what a run may
 * do:
 *
 * - command — blocked if it matches any repo `blockedCommands` pattern;
 * - domains — each must satisfy BOTH the repo `allowedNetworkDomains` and the
 *   tool's declared `networkDomains` (empty tool list = the tool declared no
 *   network use, so any domain is out of scope);
 * - writePaths — each must satisfy BOTH the repo `allowedWriteRoots` and the
 *   tool's declared `writeRoots`;
 * - action — denied if it appears in the repo `approvalRequiredActions` or the
 *   tool's `approvalActions` (no human is present in AFK, so it is blocked).
 *
 * Every breach becomes a blocked `policy-violation` {@link SafetyEvent} for the
 * evidence bundle. `allowed` is true only when there are no violations. Pure.
 */
export function authorizeToolInvocation(
  policy: SafetyPolicy,
  tool: ToolDefinition,
  invocation: ToolInvocation
): ToolAuthorization {
  const violations: PolicyViolation[] = [];

  if (invocation.command !== undefined) {
    violations.push(...checkCommand(policy, invocation.command));
  }

  for (const domain of invocation.domains ?? []) {
    violations.push(...checkNetworkDomain(policy, domain));
    // Tool scope: an empty declared list means "no network", which must block.
    if (tool.networkDomains.length === 0) {
      violations.push({
        kind: "network-domain",
        subject: domain,
        message: `tool "${tool.name}" declares no network access`,
      });
    } else {
      violations.push(
        ...checkNetworkDomain(
          scopedPolicy("allowedNetworkDomains", tool.networkDomains),
          domain
        )
      );
    }
  }

  for (const path of invocation.writePaths ?? []) {
    violations.push(...checkWritePath(policy, path));
    if (tool.writeRoots.length > 0) {
      violations.push(
        ...checkWritePath(
          scopedPolicy("allowedWriteRoots", tool.writeRoots),
          path
        )
      );
    }
  }

  if (invocation.action !== undefined) {
    const needsApproval =
      policy.approvalRequiredActions.includes(invocation.action) ||
      tool.approvalActions.includes(invocation.action);
    if (needsApproval) {
      violations.push({
        kind: "approval-required",
        subject: invocation.action,
        message: `action "${invocation.action}" requires human approval (unavailable in AFK)`,
      });
    }
  }

  const events: SafetyEvent[] = violations.map((v) => ({
    category: "policy-violation",
    kind: v.kind,
    subject: v.subject,
    message: v.message,
    blocked: true,
  }));

  return { allowed: violations.length === 0, violations, events };
}

/**
 * Build a blocked {@link ToolAuthorization} for `authorizeToolOperation`'s
 * allowlist checks (an operation the tool hasn't declared, or a stage it isn't
 * enabled for). Mirrors the `PolicyViolation`/`SafetyEvent` field names
 * `authorizeToolInvocation` uses for a blocked call. The event reuses the
 * passed axis `kind` (same as the invocation-level mapping).
 */
function blocked(
  kind: PolicyViolation["kind"],
  subject: string,
  message: string
): ToolAuthorization {
  const violation: PolicyViolation = { kind, subject, message };
  const event: SafetyEvent = {
    category: "policy-violation",
    kind,
    subject,
    message,
    blocked: true,
  };
  return { allowed: false, violations: [violation], events: [event] };
}

/**
 * Authorize one named operation on a tool (issue #P26): allowed only if the
 * tool is enabled for `stage`, `operation` is declared in `tool.operations`,
 * and — when that operation is a write — the invocation also clears
 * {@link authorizeToolInvocation}. Read ops need no invocation-level check
 * once declared. A tool with no `operations` list blocks every operation
 * (nothing is declared), leaving `authorizeToolInvocation` as the only gate
 * for tools that don't opt into per-operation authority. Pure.
 */
export function authorizeToolOperation(
  policy: SafetyPolicy,
  tool: ToolDefinition,
  config: ToolConfig,
  stage: string,
  operation: string,
  invocation: ToolInvocation
): ToolAuthorization {
  const stageGate = toolEnabledForStage(tool, config, stage);
  if (!stageGate.enabled) {
    return blocked(
      "approval-required",
      operation,
      `tool not enabled for stage ${stage}: ${stageGate.reason}`
    );
  }
  const op = tool.operations?.find((o) => o.name === operation);
  if (!op) {
    return blocked(
      "approval-required",
      operation,
      `operation not in allowlist: ${operation}`
    );
  }
  // Read ops need no write authority; write ops go through the full intersection.
  if (!op.write) return { allowed: true, violations: [], events: [] };
  return authorizeToolInvocation(policy, tool, invocation);
}
