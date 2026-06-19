import { resolve } from "node:path";

import {
  auditMemory,
  memoryDir,
  readMemoryRecords,
  type AuditReport,
  type MemoryRecord,
} from "./memory.js";

/**
 * Injectable host surface for {@link runMemory} so the bin stays unit-testable
 * without touching the real cwd/env or process stdio (mirrors `InspectDeps`).
 */
export type MemoryDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: MemoryDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const USAGE = "Usage: otto-memory audit";

/** One-line label for a record's scope: its globs, or "(repo-wide)" when empty. */
function describeScope(record: MemoryRecord): string {
  return record.scope.length ? record.scope.join(", ") : "(repo-wide)";
}

/**
 * Render a {@link AuditReport} into a compact, human-readable report answering
 * "which memories are stale, conflicting, or heavily relied upon?". Pure: takes
 * the already-computed report, returns the string (mirrors `formatRunReport`).
 */
export function formatAuditReport(report: AuditReport): string {
  const c = report.counts;
  const lines: string[] = [];
  lines.push(`  total:           ${c.total}`);
  lines.push(`  active:          ${c.active}`);
  lines.push(`  stale:           ${c.stale}`);
  lines.push(`  superseded:      ${c.superseded}`);
  lines.push(`  conflicting:     ${c.conflicting} pairs`);
  lines.push(`  frequently used: ${c.frequentlyUsed}`);

  lines.push("");
  lines.push(`Stale (${report.stale.length}):`);
  if (report.stale.length === 0) lines.push("  (none)");
  for (const r of report.stale) {
    lines.push(
      `  - ${r.id}  [${r.category ?? "uncategorized"}]  used ${r.useCount}x  scope: ${describeScope(r)}`
    );
  }

  lines.push("");
  lines.push(`Conflicting (${report.conflicting.length} pairs):`);
  if (report.conflicting.length === 0) lines.push("  (none)");
  for (const [a, b] of report.conflicting) {
    lines.push(
      `  - ${a.id} <-> ${b.id}  [${a.category ?? "uncategorized"}]  scope: ${describeScope(a)}`
    );
  }

  lines.push("");
  lines.push(`Frequently used (${report.frequentlyUsed.length}):`);
  if (report.frequentlyUsed.length === 0) lines.push("  (none)");
  for (const r of report.frequentlyUsed) {
    lines.push(`  - ${r.id}  used ${r.useCount}x  [${r.trust}]`);
  }

  return lines.join("\n");
}

/**
 * Drive the `otto-memory` command. The sole subcommand (`audit`, also the
 * default) reads every record under `.otto/memory/`, audits the set at the
 * current instant, and prints the human report. Resolves to the process exit
 * code (mirrors `runInspect`).
 */
export async function runMemory(
  argv: string[],
  deps: MemoryDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }
  if (arg !== undefined && arg !== "audit") {
    deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
    return 1;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  const records = readMemoryRecords(workspaceDir);
  deps.out(`Memory audit (${memoryDir(workspaceDir)})`);
  deps.out(formatAuditReport(auditMemory(records)));
  return 0;
}
