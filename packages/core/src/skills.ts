import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Skill extraction and reuse (issue #44 P5). A **skill** is a repo-local,
 * versioned, validated procedure promoted from repeated successful trajectories
 * — so future runs can retrieve a known workflow instead of re-planning it.
 *
 * Unlike a memory record (one JSON file), a skill is a **directory package**
 * `.otto/skills/<name>/`: `skill.json` (this metadata) + `instructions.md` (the
 * body), alongside optional scripts/tests. The `.otto/skills/` directory is the
 * list — there is no central index, exactly like `.otto/runs/` and
 * `.otto/memory/`. Pure fs + JSON, absent/malformed → safe defaults, never
 * throws (mirrors `memory.ts`/`run-report.ts`).
 *
 * This module is a substrate: it is exported from `index.ts` and read by the
 * read-only `otto-skills` bin, but **inert on the loop** — no run auto-selects or
 * auto-applies a skill this slice, so a skill cannot regress a run. Retrieval,
 * validation-gating, and candidate identification layer on top in later slices.
 */

/** Coarse provenance band, mirroring {@link MemoryTrust}. */
export type SkillTrust = "trusted" | "unverified" | "deprecated";

/**
 * Validation provenance: the successful run that last proved the skill works.
 * "Require validation before a skill is used automatically" (the issue) is
 * enforced by retrieval filtering on the DERIVED {@link skillStatus}, which is
 * computed from these fields — not by the bin executing the skill's tests.
 */
export type SkillValidation = {
  /** Run id whose trajectory last validated this skill (absent = unvalidated). */
  lastValidatedRun?: string;
  /** When that validation happened (ISO). */
  lastValidatedAt?: string;
};

/**
 * One skill package's metadata, stored as `.otto/skills/<name>/skill.json`. The
 * `instructions` body lives in the sibling `instructions.md` (or inline here as a
 * fallback) and is loaded by {@link readSkill}.
 */
export type Skill = {
  /** Filesystem-safe package name; also the directory name. */
  name: string;
  /** Free-text version (semver-ish); default "0.0.0". */
  version: string;
  /** Declared capability tags (e.g. "release-flow") — a retrieval key. */
  capabilities: string[];
  /** Guardrails — e.g. risk classes the skill must not be applied to. */
  constraints: string[];
  /** File/module globs the skill applies to; empty = repo-wide. A retrieval key. */
  scope: string[];
  /** The instruction body (from `instructions.md`, else the inline fallback). */
  instructions: string;
  /** Named helper commands the package ships (name → command string). */
  scripts: Record<string, string>;
  /** Validation command(s) that prove the skill still works. */
  tests: string[];
  validation: SkillValidation;
  trust: SkillTrust;
  createdAt: string;
  /** How many runs have consumed this skill. */
  useCount: number;
  /** Sliding revalidation window in days; past it a validated skill goes stale. */
  revalidateAfterDays?: number;
};

const TRUSTS: ReadonlySet<string> = new Set([
  "trusted",
  "unverified",
  "deprecated",
]);

const SKILLS_REL = join(".otto", "skills");
const MANIFEST_FILE = "skill.json";
const INSTRUCTIONS_FILE = "instructions.md";

/** Absolute path to the workspace's skills root (`.otto/skills`). */
export function skillsDir(workspaceDir: string): string {
  return join(workspaceDir, SKILLS_REL);
}

/** Absolute path to one skill's package dir (`.otto/skills/<name>`). */
export function skillDir(workspaceDir: string, name: string): string {
  return join(skillsDir(workspaceDir), name);
}

/** Absolute path to a skill's metadata file (`.otto/skills/<name>/skill.json`). */
export function skillManifestPath(workspaceDir: string, name: string): string {
  return join(skillDir(workspaceDir, name), MANIFEST_FILE);
}

/** Absolute path to a skill's instructions body (`.../instructions.md`). */
export function skillInstructionsPath(
  workspaceDir: string,
  name: string
): string {
  return join(skillDir(workspaceDir, name), INSTRUCTIONS_FILE);
}

/**
 * Normalize free text into a filesystem-safe, git-branch-safe skill name:
 * lowercase, every non-`[a-z0-9]` run collapsed to a single `-`, trimmed of
 * leading/trailing `-`, capped at 48 chars. Mirrors `slugify`/`deriveTaskKey`.
 */
export function toSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
}

function stringRecord(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseValidation(raw: unknown): SkillValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const v: SkillValidation = {};
  if (typeof o.lastValidatedRun === "string") {
    v.lastValidatedRun = o.lastValidatedRun;
  }
  if (typeof o.lastValidatedAt === "string") {
    v.lastValidatedAt = o.lastValidatedAt;
  }
  return v;
}

/**
 * Normalize an untrusted parsed `skill.json` value into a {@link Skill}, filling
 * safe defaults for missing/invalid fields. Returns null when the input is not an
 * object or lacks the required `name`, so a malformed package is skipped rather
 * than crashing a read. `instructions` defaults to the inline value (if any);
 * {@link readSkill} overrides it with the `instructions.md` body when present.
 */
export function parseSkill(raw: unknown): Skill | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  return {
    name: o.name,
    version: typeof o.version === "string" ? o.version : "0.0.0",
    capabilities: stringArray(o.capabilities),
    constraints: stringArray(o.constraints),
    scope: stringArray(o.scope),
    instructions: typeof o.instructions === "string" ? o.instructions : "",
    scripts: stringRecord(o.scripts),
    tests: stringArray(o.tests),
    validation: parseValidation(o.validation),
    trust:
      typeof o.trust === "string" && TRUSTS.has(o.trust)
        ? (o.trust as SkillTrust)
        : "unverified",
    createdAt:
      typeof o.createdAt === "string" ? o.createdAt : new Date(0).toISOString(),
    useCount:
      typeof o.useCount === "number" && Number.isFinite(o.useCount)
        ? o.useCount
        : 0,
    ...(typeof o.revalidateAfterDays === "number" &&
    Number.isFinite(o.revalidateAfterDays)
      ? { revalidateAfterDays: o.revalidateAfterDays }
      : {}),
  };
}

/**
 * List the skill names present under `.otto/skills/` (the package sub-dirs),
 * sorted. Absent/unreadable dir → `[]` (never throws). The directory is the
 * list; a name here is not a guarantee its `skill.json` parses (use
 * {@link readSkill}).
 */
export function listSkillIds(workspaceDir: string): string[] {
  try {
    return readdirSync(skillsDir(workspaceDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read and normalize one skill package. Parses `skill.json`, then overrides
 * `instructions` with the `instructions.md` body when that file exists. Absent or
 * malformed `skill.json` → null (never throws).
 */
export function readSkill(workspaceDir: string, name: string): Skill | null {
  let skill: Skill | null;
  try {
    skill = parseSkill(
      JSON.parse(readFileSync(skillManifestPath(workspaceDir, name), "utf8"))
    );
  } catch {
    return null;
  }
  if (!skill) return null;
  try {
    const body = readFileSync(
      skillInstructionsPath(workspaceDir, name),
      "utf8"
    );
    skill = { ...skill, instructions: body };
  } catch {
    // No instructions.md sidecar — keep the inline (or empty) instructions.
  }
  return skill;
}

/** Read every skill package under `.otto/skills/`, skipping malformed ones. */
export function readSkills(workspaceDir: string): Skill[] {
  const skills: Skill[] = [];
  for (const name of listSkillIds(workspaceDir)) {
    const s = readSkill(workspaceDir, name);
    if (s) skills.push(s);
  }
  return skills;
}

/**
 * Write a skill package: `skill.json` (metadata, with `instructions` omitted) +
 * `instructions.md` (the body). Creates `.otto/skills/<name>/`. The split keeps
 * the body as a readable, diff-friendly markdown file rather than an escaped JSON
 * string.
 */
export function writeSkill(workspaceDir: string, skill: Skill): void {
  const dir = skillDir(workspaceDir, skill.name);
  mkdirSync(dir, { recursive: true });
  const { instructions, ...meta } = skill;
  writeFileSync(
    join(dir, MANIFEST_FILE),
    JSON.stringify(meta, null, 2) + "\n"
  );
  writeFileSync(join(dir, INSTRUCTIONS_FILE), instructions);
}

/** True when a skill package directory with a `skill.json` exists. */
export function skillExists(workspaceDir: string, name: string): boolean {
  return existsSync(skillManifestPath(workspaceDir, name));
}

/**
 * Validation lifecycle (issue #44 slice 2). `unvalidated` = never proven by a
 * run (so it must not be applied automatically); `validated` = a successful run
 * proved it and it is within its freshness window; `stale` = it was validated but
 * `revalidateAfterDays` have since elapsed and it needs re-proving.
 */
export type SkillStatus = "validated" | "unvalidated" | "stale";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO timestamp to epoch ms; unparseable → null (never throws). */
function epoch(iso: string | undefined): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Derive a skill's validation status from its recorded validation + freshness
 * policy at `now`. A skill with no `validation.lastValidatedRun` is `unvalidated`;
 * one validated but past its `revalidateAfterDays` window (measured from
 * `lastValidatedAt`) is `stale`; otherwise `validated`. Unparseable timestamps
 * are ignored rather than treated as expired (mirrors `memoryStatus`). Pure —
 * the retrieval gate uses this so only `validated` skills are auto-eligible.
 */
export function skillStatus(skill: Skill, now: Date = new Date()): SkillStatus {
  if (!skill.validation.lastValidatedRun) return "unvalidated";
  if (skill.revalidateAfterDays !== undefined) {
    const since = epoch(skill.validation.lastValidatedAt);
    if (since !== null && now.getTime() - since > skill.revalidateAfterDays * DAY_MS) {
      return "stale";
    }
  }
  return "validated";
}

/**
 * Return a copy of the skill marked validated by a successful `runId` at `now`.
 * Pure — the input is not mutated; the caller writes it back to persist the
 * validation (recording a validation is a run's job, never the read-only bin's).
 */
export function recordValidation(
  skill: Skill,
  runId: string,
  now: Date = new Date()
): Skill {
  return {
    ...skill,
    validation: { lastValidatedRun: runId, lastValidatedAt: now.toISOString() },
  };
}
