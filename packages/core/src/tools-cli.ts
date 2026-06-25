import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { readSafetyPolicy, type SafetyPolicy } from "./safety-policy.js";
import {
  authorizeToolInvocation,
  readToolConfig,
  readTools,
  selectToolsForStage,
  toolsDir,
  type ToolConfig,
  type ToolDefinition,
  type ToolSelection,
} from "./tools.js";

/**
 * Injectable host surface for {@link runTools} so the bin stays unit-testable
 * without touching real cwd/env/stdio or spawning processes (mirrors
 * `SkillsDeps`). `health` is injected so tests don't shell out.
 */
export type ToolsDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
  /** Run a tool's health-check command; resolves to its availability. */
  health: (tool: ToolDefinition) => Promise<{ ok: boolean; detail: string }>;
};

/** Default health probe: run `healthCheck` in a shell, ok = exit 0. */
function defaultHealth(
  tool: ToolDefinition
): Promise<{ ok: boolean; detail: string }> {
  if (!tool.healthCheck) {
    return Promise.resolve({ ok: false, detail: "no health check defined" });
  }
  const r = spawnSync(tool.healthCheck, {
    shell: true,
    timeout: tool.timeoutMs ?? 10_000,
    encoding: "utf8",
  });
  if (r.status === 0) return Promise.resolve({ ok: true, detail: "ok" });
  const why =
    r.error?.message ??
    (r.status === null ? "timed out / killed" : `exit ${r.status}`);
  return Promise.resolve({ ok: false, detail: why });
}

const defaultDeps: ToolsDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
  health: defaultHealth,
};

const USAGE =
  "Usage: otto-tools <list|audit|health>\n" + "       otto-tools why <stage>";

function scopeLabel(tool: ToolDefinition): string {
  const parts: string[] = [];
  if (tool.networkDomains.length)
    parts.push(`net: ${tool.networkDomains.join(", ")}`);
  if (tool.writeRoots.length)
    parts.push(`write: ${tool.writeRoots.join(", ")}`);
  if (tool.secretRefs.length)
    parts.push(`secrets: ${tool.secretRefs.join(", ")}`);
  return parts.length ? parts.join("  ") : "(no command/network/write scope)";
}

/** Render the tool registry inventory. Pure. */
export function formatToolsList(
  tools: ToolDefinition[],
  config: ToolConfig
): string {
  if (tools.length === 0) {
    return "No tools. A tool is a .otto/tools/<name>.json adapter definition. Existing runs are unaffected.";
  }
  const lines: string[] = [];
  for (const t of tools) {
    const ov = config.overrides[t.name];
    const enabled = ov?.enabled ?? t.enabled;
    const stages = ov?.stages ?? t.stages;
    lines.push(
      `- ${t.name}  [${t.kind}]  ${enabled ? "enabled" : "disabled"}  stages: ${stages.length ? stages.join(", ") : "(none)"}`
    );
    if (t.capabilities.length)
      lines.push(`    capabilities: ${t.capabilities.join(", ")}`);
    lines.push(`    scope:        ${scopeLabel(t)}`);
  }
  return lines.join("\n");
}

/** One governance problem with the tool registry. */
export type ToolAuditFinding = {
  kind: "unreachable" | "no-health-check" | "policy-conflict";
  subject: string;
  detail: string;
};

/**
 * Audit the registry against config + safety policy. Flags tools that are
 * enabled but reachable from no stage (`unreachable`), command/mcp/proxy/http
 * tools with no way to verify availability (`no-health-check`), and tools whose
 * declared scope a non-empty repo policy already forbids (`policy-conflict`),
 * e.g. a network domain outside `allowedNetworkDomains`. Pure over its inputs.
 */
export function auditTools(
  tools: ToolDefinition[],
  config: ToolConfig
): ToolAuditFinding[] {
  const findings: ToolAuditFinding[] = [];
  for (const t of tools) {
    const ov = config.overrides[t.name];
    const enabled = ov?.enabled ?? t.enabled;
    const stages = ov?.stages ?? t.stages;
    if (enabled && stages.length === 0) {
      findings.push({
        kind: "unreachable",
        subject: t.name,
        detail: `tool "${t.name}" is enabled but has no stage allowlist — it can never be selected`,
      });
    }
    if (!t.healthCheck && t.kind !== "sdk") {
      findings.push({
        kind: "no-health-check",
        subject: t.name,
        detail: `tool "${t.name}" (${t.kind}) has no healthCheck — availability cannot be verified`,
      });
    }
  }
  return findings.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)
  );
}

/**
 * Audit each tool's declared scope against a non-empty repo policy: a tool that
 * declares a network domain or write root the policy forbids is a standing
 * `policy-conflict` (the authorization layer would block every such invocation).
 * Separated from {@link auditTools} so it can take the workspace policy. Pure.
 */
export function auditToolPolicyConflicts(
  tools: ToolDefinition[],
  policy: SafetyPolicy
): ToolAuditFinding[] {
  const findings: ToolAuditFinding[] = [];
  for (const t of tools) {
    for (const domain of t.networkDomains) {
      const a = authorizeToolInvocation(policy, t, { domains: [domain] });
      if (a.violations.some((v) => v.kind === "network-domain")) {
        findings.push({
          kind: "policy-conflict",
          subject: t.name,
          detail: `tool "${t.name}" declares domain "${domain}" the repo policy forbids`,
        });
      }
    }
    for (const root of t.writeRoots) {
      const a = authorizeToolInvocation(policy, t, { writePaths: [root] });
      if (a.violations.some((v) => v.kind === "write-root")) {
        findings.push({
          kind: "policy-conflict",
          subject: t.name,
          detail: `tool "${t.name}" declares write root "${root}" the repo policy forbids`,
        });
      }
    }
  }
  return findings.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** Render audit findings. Pure. */
export function formatToolsAudit(findings: ToolAuditFinding[]): string {
  if (findings.length === 0) return "Tool registry clean (no findings).";
  const lines: string[] = [`Tool registry findings (${findings.length}):`];
  for (const f of findings) lines.push(`  - [${f.kind}] ${f.detail}`);
  return lines.join("\n");
}

/** Render which tools are available for a stage and why. Pure. */
export function formatToolsWhy(
  stage: string,
  selections: ToolSelection[]
): string {
  if (selections.length === 0) return "No tools registered.";
  const lines: string[] = [`Tools for stage "${stage}":`];
  for (const s of selections) {
    lines.push(
      `- ${s.name}  [${s.enabled ? "available" : "skip"}]  ${s.reason}`
    );
  }
  return lines.join("\n");
}

/**
 * Drive the read-only `otto-tools` operator command over `.otto/tools/`.
 * Subcommands: `list` (default) inventories the registry + config state;
 * `audit` flags governance problems (unreachable, missing health check, policy
 * conflict); `why <stage>` shows which tools a stage may use and why; `health`
 * runs each tool's health-check. Read-only — it never invokes a tool's actual
 * adapter, only its health probe. Resolves to the process exit code.
 */
export async function runTools(
  argv: string[],
  deps: ToolsDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }
  const known = ["list", "audit", "why", "health"];
  if (arg !== undefined && !known.includes(arg)) {
    deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
    return 1;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  const tools = readTools(workspaceDir);
  const config = readToolConfig(workspaceDir);

  if (arg === "why") {
    const stage = argv[1];
    if (!stage) {
      deps.err(`why needs a stage name.\n${USAGE}`);
      return 1;
    }
    deps.out(formatToolsWhy(stage, selectToolsForStage(tools, config, stage)));
    return 0;
  }

  if (arg === "audit") {
    const policy = readSafetyPolicy(workspaceDir);
    const findings = [
      ...auditTools(tools, config),
      ...auditToolPolicyConflicts(tools, policy),
    ].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)
    );
    deps.out(formatToolsAudit(findings));
    return findings.length === 0 ? 0 : 1;
  }

  if (arg === "health") {
    if (tools.length === 0) {
      deps.out("No tools to health-check.");
      return 0;
    }
    let allOk = true;
    deps.out(`Tool health (${toolsDir(workspaceDir)})`);
    for (const t of tools) {
      const { ok, detail } = await deps.health(t);
      if (!ok) allOk = false;
      deps.out(`  ${ok ? "ok  " : "FAIL"} ${t.name}  ${detail}`);
    }
    return allOk ? 0 : 1;
  }

  deps.out(`Tools (${toolsDir(workspaceDir)})`);
  deps.out(formatToolsList(tools, config));
  return 0;
}
