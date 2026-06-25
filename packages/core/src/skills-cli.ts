import { resolve } from "node:path";

import {
  addSource,
  applySync,
  auditExternal,
  importedChecksum,
  planSync,
  readLock,
  readSources,
  removeSource,
  writeSources,
  type ExternalAuditFinding,
  type ExternalSkillSource,
  type ExternalSourceType,
  type SyncPlan,
} from "./external-skills.js";
import { listRunIds, readManifest } from "./run-report.js";
import {
  needsRevalidation,
  validateSkill,
  type SkillValidationReport,
} from "./skill-validation.js";
import {
  findSkillCandidates,
  readSkill,
  readSkills,
  recordStaticValidation,
  selectSkills,
  skillsDir,
  skillStatus,
  writeSkill,
  type CandidateRun,
  type Skill,
  type SkillCandidate,
  type SkillMatch,
} from "./skills.js";

/**
 * Injectable host surface for {@link runSkills} so the bin stays unit-testable
 * without touching the real cwd/env or process stdio (mirrors `MemoryDeps`).
 */
export type SkillsDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: SkillsDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const USAGE =
  "Usage: otto-skills <list|audit|candidates>\n" +
  "       otto-skills why <changed-path>...\n" +
  "       otto-skills validate <skill> [--source <name>]\n" +
  "       otto-skills sources <list|add|remove> ...\n" +
  "       otto-skills sync [--dry-run]\n" +
  "       otto-skills audit --external";

/** One-line scope label: the globs, or "(repo-wide)" when empty. */
function scopeLabel(skill: Skill): string {
  return skill.scope.length ? skill.scope.join(", ") : "(repo-wide)";
}

/**
 * Render the skill inventory with each skill's DERIVED validation status, trust,
 * and capabilities/scope. Pure (clock injected). `now` drives freshness.
 */
export function formatSkillsReport(
  skills: Skill[],
  now: Date = new Date()
): string {
  if (skills.length === 0) {
    return "No skills yet. A skill is a .otto/skills/<name>/ package (skill.json + instructions.md).";
  }
  const lines: string[] = [];
  for (const s of skills) {
    const caps = s.capabilities.length ? s.capabilities.join(", ") : "(none)";
    lines.push(
      `- ${s.name}@${s.version}  [${skillStatus(s, now)}/${s.trust}]  used ${s.useCount}x`
    );
    lines.push(`    capabilities: ${caps}`);
    lines.push(`    scope:        ${scopeLabel(s)}`);
  }
  return lines.join("\n");
}

/**
 * Render a governance summary: how many skills are validated (auto-usable),
 * unvalidated, or stale, and which are not yet usable. Pure (clock injected).
 */
export function formatSkillsAudit(
  skills: Skill[],
  now: Date = new Date()
): string {
  const status = skills.map((s) => ({ s, st: skillStatus(s, now) }));
  const count = (k: string) => status.filter((x) => x.st === k).length;
  const lines: string[] = [];
  lines.push(`  total:        ${skills.length}`);
  lines.push(`  validated:    ${count("validated")}`);
  lines.push(`  unvalidated:  ${count("unvalidated")}`);
  lines.push(`  stale:        ${count("stale")}`);

  const notUsable = status.filter((x) => x.st !== "validated");
  lines.push("");
  lines.push(`Not yet usable (${notUsable.length}):`);
  if (notUsable.length === 0) lines.push("  (none — all validated)");
  for (const { s, st } of notUsable) {
    lines.push(
      `  - ${s.name}  [${st}]  (run its tests, then record a validating run)`
    );
  }

  // Body-drift detection (issue #135): a statically-validated skill whose body
  // changed since the gate ran must be revalidated before it is reused.
  const drifted = skills.filter(needsRevalidation);
  lines.push("");
  lines.push(`Needs revalidation — body drifted (${drifted.length}):`);
  if (drifted.length === 0) lines.push("  (none)");
  for (const s of drifted) {
    lines.push(`  - ${s.name}  (re-run: otto-skills validate ${s.name})`);
  }
  return lines.join("\n");
}

/**
 * Render a retrieval explanation: the ranked {@link SkillMatch}es for a set of
 * changed paths, each with whether it is eligible and WHY (the issue's
 * "inspect why a skill was selected" metric). Pure.
 */
export function formatWhy(matches: SkillMatch[]): string {
  if (matches.length === 0) return "No skills to match.";
  const lines: string[] = [];
  for (const m of matches) {
    lines.push(
      `- ${m.name}  [${m.eligible ? "eligible" : "skip"}]  score ${m.score}`
    );
    for (const r of m.reasons) lines.push(`    · ${r}`);
  }
  return lines.join("\n");
}

/** Render the candidate skills suggested from repeated successful runs. Pure. */
export function formatCandidates(candidates: SkillCandidate[]): string {
  if (candidates.length === 0) {
    return "No skill candidates: no successful workflow has repeated yet (need >= 2 runs of the same task).";
  }
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`- ${c.suggestedName}  (${c.count} successful runs)`);
    lines.push(`    signature: ${c.bin} / ${c.mode} / ${c.inputs || "(none)"}`);
    lines.push(`    runs:      ${c.runIds.join(", ")}`);
  }
  return lines.join("\n");
}

/** Render the configured external sources, sorted. Pure. */
export function formatSources(sources: ExternalSkillSource[]): string {
  if (sources.length === 0) {
    return "No external sources. Add one: otto-skills sources add <name> <url-or-path> [--ref <sha-or-tag>] [--type local|git|archive]";
  }
  const lines: string[] = [];
  for (const s of [...sources].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `- ${s.name}  [${s.type}]  ${s.location}${s.ref ? `  @${s.ref}` : "  (unpinned)"}`
    );
  }
  return lines.join("\n");
}

/** Render a sync plan; `dryRun` flips the header between preview and applied. Pure. */
export function formatSyncPlan(plan: SyncPlan, dryRun: boolean): string {
  if (plan.items.length === 0) {
    return "Nothing to sync (no local sources resolved any SKILL.md packages).";
  }
  const lines: string[] = [
    dryRun ? "Sync plan (--dry-run, nothing written):" : "Synced:",
  ];
  for (const i of plan.items) {
    const note =
      i.action === "conflict"
        ? `  (name already claimed by ${i.conflictWith})`
        : "";
    lines.push(`  ${i.action.padEnd(9)} ${i.skill}  <- ${i.source}${note}`);
  }
  const conflicts = plan.items.filter((i) => i.action === "conflict").length;
  if (conflicts > 0) {
    lines.push(
      `\n${conflicts} conflict(s) skipped — rename or drop the duplicate source.`
    );
  }
  return lines.join("\n");
}

/**
 * Render a skill validation report (issue #113 P17): the extracted capabilities,
 * each finding with its severity/rule/message/remediation, and a pass/fail line.
 * Pure — the bin decides the exit code from `report.ok`.
 */
export function formatValidationReport(report: SkillValidationReport): string {
  const scope =
    report.compatibility === "stage-scoped" && report.stages.length
      ? ` (${report.stages.join(", ")})`
      : "";
  const lines: string[] = [
    `Validating skill '${report.skill}'`,
    `  capabilities: ${report.capabilities.length ? report.capabilities.join(", ") : "(none)"}`,
    `  compatibility: ${report.compatibility}${scope}`,
  ];
  if (report.findings.length === 0) {
    lines.push("  no findings");
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity}] ${f.rule}: ${f.message}`);
      lines.push(`      → ${f.remediation}`);
    }
  }
  const applied = report.drills.filter((d) => d.applied);
  if (applied.length > 0) {
    lines.push("  drills:");
    for (const d of applied) {
      lines.push(`    ${d.passed ? "pass" : "FAIL"}  ${d.drill}: ${d.detail}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok ? "PASS (no blocking errors)" : "FAIL (blocking errors present)"
  );
  return lines.join("\n");
}

/** Render the external-registry audit findings. Pure. */
export function formatExternalAudit(findings: ExternalAuditFinding[]): string {
  if (findings.length === 0) return "External registry clean (no findings).";
  const lines: string[] = [`External registry findings (${findings.length}):`];
  for (const f of findings) lines.push(`  - [${f.kind}] ${f.detail}`);
  return lines.join("\n");
}

/**
 * Drive the `otto-skills` command over `.otto/skills/`. Inspection subcommands:
 * `list` (default) inventories skills + derived status; `audit` summarizes
 * usable/unvalidated/stale (`audit --external` audits the import registry);
 * `why <path>...` shows which skills retrieval would select for those changed
 * paths and why; `candidates` suggests skills from repeated successful runs.
 * Registry subcommands (issue #110 P16): `sources <list|add|remove>` edits
 * `.otto/skills/sources.json`, and `sync [--dry-run]` imports external packs as
 * inert, unverified skills + refreshes `.otto/skills.lock.json`. It never
 * executes a skill's tests, and import never makes a skill eligible for a run.
 * Resolves to the process exit code (mirrors `runMemory`).
 */
export async function runSkills(
  argv: string[],
  deps: SkillsDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }
  const known = [
    "list",
    "audit",
    "why",
    "validate",
    "candidates",
    "sources",
    "sync",
  ];
  if (arg !== undefined && !known.includes(arg)) {
    deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
    return 1;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);

  if (arg === "sources") {
    return runSources(argv.slice(1), workspaceDir, deps);
  }

  if (arg === "sync") {
    const dryRun = argv.includes("--dry-run");
    const plan = planSync(workspaceDir, readSources(workspaceDir), new Date());
    if (!dryRun) applySync(workspaceDir, plan);
    deps.out(formatSyncPlan(plan, dryRun));
    return 0;
  }

  const skills = readSkills(workspaceDir);

  if (arg === "why") {
    const paths = argv.slice(1);
    if (paths.length === 0) {
      deps.err(`why needs at least one changed path.\n${USAGE}`);
      return 1;
    }
    deps.out(formatWhy(selectSkills(skills, { changedPaths: paths })));
    return 0;
  }

  if (arg === "validate") {
    const rest = argv.slice(1);
    const name = rest.find((a) => !a.startsWith("--"));
    if (!name) {
      deps.err(`validate needs a skill name.\n${USAGE}`);
      return 1;
    }
    const skill = readSkill(workspaceDir, name);
    if (!skill) {
      deps.err(`No skill named '${name}' under ${skillsDir(workspaceDir)}.`);
      return 1;
    }
    const source = flagValue(rest, "--source");
    const report = validateSkill(skill, source ? { source } : {});
    deps.out(formatValidationReport(report));
    // Persist the static-gate outcome (issue #134). Recording a class does NOT
    // make the skill eligible — selection stays a separate concern (P18).
    writeSkill(
      workspaceDir,
      recordStaticValidation(skill, {
        compatibility: report.compatibility,
        stages: report.stages,
        checksum: report.checksum,
      })
    );
    return report.ok ? 0 : 1;
  }

  if (arg === "candidates") {
    const runs: CandidateRun[] = listRunIds(workspaceDir)
      .map((id) => readManifest(workspaceDir, id))
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map((m) => ({
        runId: m.runId,
        bin: m.bin,
        mode: m.mode,
        inputs: m.inputs,
        exitReason: m.exitReason,
      }));
    deps.out(formatCandidates(findSkillCandidates(runs)));
    return 0;
  }

  if (arg === "audit") {
    if (argv.includes("--external")) {
      const findings = auditExternal(
        readSources(workspaceDir),
        readLock(workspaceDir),
        (s) => importedChecksum(workspaceDir, s)
      );
      deps.out(formatExternalAudit(findings));
      return findings.length === 0 ? 0 : 1;
    }
    deps.out(`Skills audit (${skillsDir(workspaceDir)})`);
    deps.out(formatSkillsAudit(skills));
    return 0;
  }

  deps.out(`Skills (${skillsDir(workspaceDir)})`);
  deps.out(formatSkillsReport(skills));
  return 0;
}

const SOURCES_USAGE =
  "Usage: otto-skills sources list\n" +
  "       otto-skills sources add <name> <url-or-path> [--ref <sha-or-tag>] [--type local|git|archive]\n" +
  "       otto-skills sources remove <name>";

/** Read a `--flag value` from argv, or undefined. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const SOURCE_TYPES: ReadonlySet<string> = new Set(["local", "git", "archive"]);

/**
 * Handle `otto-skills sources <list|add|remove>`. Unlike the rest of the bin
 * these mutate `.otto/skills/sources.json`, but they only edit the source
 * registry — no skill is imported or made eligible until a later `sync` +
 * validation. Resolves to an exit code.
 */
function runSources(
  argv: string[],
  workspaceDir: string,
  deps: SkillsDeps
): number {
  const sub = argv[0];
  if (sub === undefined || sub === "list") {
    deps.out(formatSources(readSources(workspaceDir)));
    return 0;
  }

  if (sub === "add") {
    const name = argv[1];
    const location = argv[2];
    if (!name || !location || location.startsWith("--")) {
      deps.err(`add needs <name> and <url-or-path>.\n${SOURCES_USAGE}`);
      return 1;
    }
    const ref = flagValue(argv, "--ref");
    const rawType = flagValue(argv, "--type") ?? "local";
    if (!SOURCE_TYPES.has(rawType)) {
      deps.err(`Unknown --type '${rawType}' (local|git|archive).`);
      return 1;
    }
    const source: ExternalSkillSource = {
      name,
      type: rawType as ExternalSourceType,
      location,
    };
    if (ref) source.ref = ref;
    writeSources(workspaceDir, addSource(readSources(workspaceDir), source));
    deps.out(`Added source '${name}'. Run: otto-skills sync --dry-run`);
    return 0;
  }

  if (sub === "remove") {
    const name = argv[1];
    if (!name) {
      deps.err(`remove needs <name>.\n${SOURCES_USAGE}`);
      return 1;
    }
    const before = readSources(workspaceDir);
    if (!before.some((s) => s.name === name)) {
      deps.err(`No source named '${name}'.`);
      return 1;
    }
    writeSources(workspaceDir, removeSource(before, name));
    deps.out(`Removed source '${name}'.`);
    return 0;
  }

  deps.err(`Unknown sources subcommand '${sub}'.\n${SOURCES_USAGE}`);
  return 1;
}
