import { resolve } from "node:path";

import { listRunIds, readManifest } from "./run-report.js";
import {
  findSkillCandidates,
  readSkills,
  selectSkills,
  skillsDir,
  skillStatus,
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
  "       otto-skills why <changed-path>...";

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
    lines.push(`  - ${s.name}  [${st}]  (run its tests, then record a validating run)`);
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
    lines.push(`- ${m.name}  [${m.eligible ? "eligible" : "skip"}]  score ${m.score}`);
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

/**
 * Drive the read-only `otto-skills` command over `.otto/skills/`. Subcommands:
 * `list` (default) inventories skills + derived status; `audit` summarizes
 * usable/unvalidated/stale; `why <path>...` shows which skills retrieval would
 * select for those changed paths and why; `candidates` suggests skills from
 * repeated successful runs. Read-only — it never executes a skill's tests or
 * mutates a package. Resolves to the process exit code (mirrors `runMemory`).
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
  const known = ["list", "audit", "why", "candidates"];
  if (arg !== undefined && !known.includes(arg)) {
    deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
    return 1;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
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
    deps.out(`Skills audit (${skillsDir(workspaceDir)})`);
    deps.out(formatSkillsAudit(skills));
    return 0;
  }

  deps.out(`Skills (${skillsDir(workspaceDir)})`);
  deps.out(formatSkillsReport(skills));
  return 0;
}
