import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  skillDir,
  skillExists,
  toSkillName,
  writeSkill,
  type ImportedSkillProvenance,
  type Skill,
} from "./skills.js";

/**
 * External skill source registry (issue #110 P16). Otto can import outside skill
 * packs (Superpowers, PM-Skills, …) into the existing `.otto/skills/<name>/`
 * package shape, but **import is separated from trust and runtime use**: every
 * imported skill lands as `trust: "unverified"` with empty validation, so it
 * stays inert on the loop until a later validation/activation slice (P17/P18).
 *
 * Two files back the registry, both pure fs + JSON with safe defaults (never
 * throw on the read path, mirroring `skills.ts`/`memory.ts`):
 *
 * - `.otto/skills/sources.json` — the configured sources (`{ sources: [...] }`).
 * - `.otto/skills.lock.json`    — what was actually resolved and imported:
 *   resolved ref, checksum, import timestamp, source type, license, normalized
 *   skill name and capabilities, for deterministic diffing and drift audits.
 *
 * This slice supports `local` source directories (the roadmap's "local fixture
 * directories before networked git fetch"). `git`/`archive` resolution layers on
 * top later without changing the lock/normalization shape.
 */

/** A source's transport kind. `registry` is reserved for a later slice. */
export type ExternalSourceType = "git" | "local" | "archive" | "registry";

/** One configured external skill source (`.otto/skills/sources.json`). */
export type ExternalSkillSource = {
  /** Registry key, unique within sources.json. */
  name: string;
  type: ExternalSourceType;
  /** URL (git/archive) or filesystem path (local). */
  location: string;
  /** Pinned ref (sha/tag). Absent = unpinned (an audit finding). */
  ref?: string;
};

/** One resolved import in `.otto/skills.lock.json`. */
export type ExternalSkillLockEntry = {
  /** Normalized skill name = `.otto/skills/<skill>` directory. */
  skill: string;
  /** Source name it came from. */
  source: string;
  type: ExternalSourceType;
  /** Package path within the source tree. */
  upstreamPath: string;
  /** Resolved ref the source was pinned to, if any. */
  ref?: string;
  /** Content checksum of the imported package. */
  checksum: string;
  /** Import timestamp (ISO). */
  importedAt: string;
  license?: string;
  capabilities: string[];
};

export type ExternalSkillLock = { entries: ExternalSkillLockEntry[] };

const SOURCES_REL = join(".otto", "skills", "sources.json");
const LOCK_REL = join(".otto", "skills.lock.json");
const SKILL_MD = "SKILL.md";
const MAX_DEPTH = 8;

/** Absolute path to the sources config (`.otto/skills/sources.json`). */
export function sourcesPath(workspaceDir: string): string {
  return join(workspaceDir, SOURCES_REL);
}

/** Absolute path to the import lockfile (`.otto/skills.lock.json`). */
export function lockPath(workspaceDir: string): string {
  return join(workspaceDir, LOCK_REL);
}

const SOURCE_TYPES: ReadonlySet<string> = new Set([
  "git",
  "local",
  "archive",
  "registry",
]);

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
}

/** Normalize one untrusted source entry; null when it lacks the required shape. */
export function parseSource(raw: unknown): ExternalSkillSource | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  if (typeof o.location !== "string" || o.location.length === 0) return null;
  const type =
    typeof o.type === "string" && SOURCE_TYPES.has(o.type)
      ? (o.type as ExternalSourceType)
      : "local";
  const src: ExternalSkillSource = { name: o.name, type, location: o.location };
  if (typeof o.ref === "string" && o.ref.length > 0) src.ref = o.ref;
  return src;
}

/** Read configured sources; absent/malformed → `[]` (never throws). */
export function readSources(workspaceDir: string): ExternalSkillSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcesPath(workspaceDir), "utf8"));
  } catch {
    return [];
  }
  const list =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).sources
      : parsed;
  if (!Array.isArray(list)) return [];
  const out: ExternalSkillSource[] = [];
  for (const r of list) {
    const s = parseSource(r);
    if (s) out.push(s);
  }
  return out;
}

/** Write the sources config, sorted by name for deterministic diffs. */
export function writeSources(
  workspaceDir: string,
  sources: ExternalSkillSource[]
): void {
  const sorted = [...sources].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(
    sourcesPath(workspaceDir),
    JSON.stringify({ sources: sorted }, null, 2) + "\n"
  );
}

function parseLockEntry(raw: unknown): ExternalSkillLockEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.skill !== "string" || typeof o.source !== "string") return null;
  if (typeof o.checksum !== "string" || typeof o.importedAt !== "string") {
    return null;
  }
  const type =
    typeof o.type === "string" && SOURCE_TYPES.has(o.type)
      ? (o.type as ExternalSourceType)
      : "local";
  const e: ExternalSkillLockEntry = {
    skill: o.skill,
    source: o.source,
    type,
    upstreamPath: typeof o.upstreamPath === "string" ? o.upstreamPath : "",
    checksum: o.checksum,
    importedAt: o.importedAt,
    capabilities: stringArray(o.capabilities),
  };
  if (typeof o.ref === "string") e.ref = o.ref;
  if (typeof o.license === "string") e.license = o.license;
  return e;
}

/** Read the import lock; absent/malformed → `{ entries: [] }` (never throws). */
export function readLock(workspaceDir: string): ExternalSkillLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath(workspaceDir), "utf8"));
  } catch {
    return { entries: [] };
  }
  const list =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).entries
      : parsed;
  if (!Array.isArray(list)) return { entries: [] };
  const entries: ExternalSkillLockEntry[] = [];
  for (const r of list) {
    const e = parseLockEntry(r);
    if (e) entries.push(e);
  }
  return { entries };
}

/** Write the lock, entries sorted by skill name for deterministic diffs. */
export function writeLock(workspaceDir: string, lock: ExternalSkillLock): void {
  const entries = [...lock.entries].sort((a, b) =>
    a.skill.localeCompare(b.skill)
  );
  writeFileSync(
    lockPath(workspaceDir),
    JSON.stringify({ entries }, null, 2) + "\n"
  );
}

/** Add (or replace by name) a source. Pure — returns a new array. */
export function addSource(
  sources: ExternalSkillSource[],
  source: ExternalSkillSource
): ExternalSkillSource[] {
  return [...sources.filter((s) => s.name !== source.name), source];
}

/** Remove a source by name. Pure — returns a new array. */
export function removeSource(
  sources: ExternalSkillSource[],
  name: string
): ExternalSkillSource[] {
  return sources.filter((s) => s.name !== name);
}

/** sha256 of a buffer/string, hex (stable content checksum). */
function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Parse a leading `--- … ---` frontmatter block into flat string fields plus the
 * remaining body. Minimal `key: value` parsing (no nested YAML) — enough for the
 * `name`/`description`/`license`/`capabilities` fields skill packs declare.
 */
export function parseFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

/** A SKILL.md package located inside a source tree, before normalization. */
export type DiscoveredPackage = {
  /** Normalized skill name (also the `.otto/skills/<name>` dir). */
  name: string;
  /** Package path within the source tree (POSIX-style, for the lock). */
  upstreamPath: string;
  /** Raw SKILL.md content. */
  raw: string;
};

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Find every `SKILL.md` package under a local source directory (recursively,
 * depth-bounded). Covers the `skills/<name>/SKILL.md` Superpowers/PM-Skills shape
 * and `.codex-plugin`/`.claude-plugin` bundles that nest the same file. Each
 * package's skill name comes from its SKILL.md `name:` frontmatter, else its
 * containing directory name, slugified. Returns packages sorted by name. Absent/
 * unreadable dir → `[]` (never throws).
 */
export function discoverPackages(sourceDir: string): DiscoveredPackage[] {
  const found: DiscoveredPackage[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const mdPath = join(dir, SKILL_MD);
    if (existsSync(mdPath)) {
      let raw: string;
      try {
        raw = readFileSync(mdPath, "utf8");
      } catch {
        raw = "";
      }
      const { fields } = parseFrontmatter(raw);
      const rel = relative(sourceDir, dir);
      const name =
        toSkillName(fields.name ?? "") ||
        toSkillName(rel.split(sep).pop() ?? "") ||
        toSkillName(rel);
      if (name) {
        found.push({
          name,
          upstreamPath: rel === "" ? "." : rel.split(sep).join("/"),
          raw,
        });
      }
      return; // a package directory is a leaf; don't descend into it
    }
    for (const child of listDirs(dir)) walk(join(dir, child), depth + 1);
  };
  walk(sourceDir, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalize a discovered package + its source into an unverified, inert
 * {@link Skill} plus the resolved {@link ExternalSkillLockEntry}. The skill body
 * is the SKILL.md content minus frontmatter; capabilities come from a
 * `capabilities:` frontmatter field when present (else empty); trust is always
 * `unverified` and validation empty so the loop cannot apply it. `now` is the
 * import timestamp (injected for deterministic tests).
 */
export function normalizePackage(
  source: ExternalSkillSource,
  pkg: DiscoveredPackage,
  now: Date
): { skill: Skill; entry: ExternalSkillLockEntry } {
  const { fields, body } = parseFrontmatter(pkg.raw);
  const capabilities = splitList(fields.capabilities);
  const license = fields.license;
  // Checksum the persisted body (what lands in instructions.md) so a later audit
  // can recompute it from disk and detect hand-edits after import.
  const instructions = body.trim() + "\n";
  const sum = checksum(instructions);
  const provenance: ImportedSkillProvenance = {
    source: source.name,
    upstreamPath: pkg.upstreamPath,
    checksum: sum,
  };
  if (source.ref) provenance.upstreamRef = source.ref;
  if (license) provenance.license = license;

  const skill: Skill = {
    name: pkg.name,
    version: typeof fields.version === "string" ? fields.version : "0.0.0",
    capabilities,
    constraints: [],
    scope: [],
    instructions,
    scripts: {},
    tests: [],
    validation: {},
    trust: "unverified",
    createdAt: now.toISOString(),
    useCount: 0,
    provenance,
  };

  const entry: ExternalSkillLockEntry = {
    skill: pkg.name,
    source: source.name,
    type: source.type,
    upstreamPath: pkg.upstreamPath,
    checksum: sum,
    importedAt: now.toISOString(),
    capabilities,
  };
  if (source.ref) entry.ref = source.ref;
  if (license) entry.license = license;

  return { skill, entry };
}

/** What a `sync` would do to one skill package. */
export type SyncAction = "add" | "update" | "unchanged" | "conflict";

export type SyncPlanItem = {
  skill: string;
  source: string;
  action: SyncAction;
  /** Set for `conflict`: the other source already claiming this name. */
  conflictWith?: string;
  /** Resolved skill + lock entry (carried so apply needn't re-normalize). */
  resolved: { skill: Skill; entry: ExternalSkillLockEntry };
};

export type SyncPlan = { items: SyncPlanItem[] };

/**
 * Compute a deterministic sync plan over the given local sources without writing
 * anything — the engine behind both `sync --dry-run` and `sync`. For each source
 * (in name order) every discovered package is classified:
 *
 * - `conflict`  — a different source earlier in the plan already claims the name;
 * - `add`       — the skill is not present on disk;
 * - `update`    — present, but the lock's recorded checksum differs (drift);
 * - `unchanged` — present and the checksum matches the lock.
 *
 * Only `local` sources resolve in this slice; other types are skipped (a later
 * slice adds git/archive fetch ahead of this same planner).
 */
export function planSync(
  workspaceDir: string,
  sources: ExternalSkillSource[],
  now: Date
): SyncPlan {
  const lock = readLock(workspaceDir);
  const lockBySkill = new Map(lock.entries.map((e) => [e.skill, e]));
  const claimedBy = new Map<string, string>();
  const items: SyncPlanItem[] = [];

  for (const source of [...sources].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (source.type !== "local") continue;
    for (const pkg of discoverPackages(source.location)) {
      const resolved = normalizePackage(source, pkg, now);
      const claimer = claimedBy.get(pkg.name);
      if (claimer && claimer !== source.name) {
        items.push({
          skill: pkg.name,
          source: source.name,
          action: "conflict",
          conflictWith: claimer,
          resolved,
        });
        continue;
      }
      claimedBy.set(pkg.name, source.name);

      let action: SyncAction;
      const locked = lockBySkill.get(pkg.name);
      if (!skillExists(workspaceDir, pkg.name) || !locked) {
        action = "add";
      } else if (locked.checksum !== resolved.entry.checksum) {
        action = "update";
      } else {
        action = "unchanged";
      }
      items.push({ skill: pkg.name, source: source.name, action, resolved });
    }
  }
  return { items };
}

/**
 * Apply a sync plan: write each `add`/`update` skill package and refresh the lock
 * to exactly the set of resolved (non-conflict) packages. `conflict` items are
 * skipped (logged by the caller). Returns the persisted lock. Side-effecting
 * counterpart to {@link planSync}; the dry-run path calls `planSync` only.
 */
export function applySync(
  workspaceDir: string,
  plan: SyncPlan
): ExternalSkillLock {
  const entries: ExternalSkillLockEntry[] = [];
  for (const item of plan.items) {
    if (item.action === "conflict") continue;
    if (item.action === "add" || item.action === "update") {
      writeSkill(workspaceDir, item.resolved.skill);
    }
    entries.push(item.resolved.entry);
  }
  const lock: ExternalSkillLock = { entries };
  writeLock(workspaceDir, lock);
  return lock;
}

/** One governance problem with the external registry. */
export type ExternalAuditFinding = {
  kind:
    | "unpinned-ref"
    | "missing-license"
    | "duplicate-name"
    | "unsupported-format"
    | "stale-copy";
  subject: string;
  detail: string;
};

/**
 * Audit the external registry (`otto-skills audit --external`). Surfaces:
 * unpinned source refs, lock entries with no license, duplicate skill names
 * across sources, sources whose type this slice cannot resolve, and stale
 * imported copies (on-disk skill checksum drifted from the lock). Pure over the
 * given sources/lock + a checksum probe; deterministic, sorted by kind+subject.
 */
export function auditExternal(
  sources: ExternalSkillSource[],
  lock: ExternalSkillLock,
  onDiskChecksum: (skill: string) => string | null
): ExternalAuditFinding[] {
  const findings: ExternalAuditFinding[] = [];

  for (const s of sources) {
    if ((s.type === "git" || s.type === "archive") && !s.ref) {
      findings.push({
        kind: "unpinned-ref",
        subject: s.name,
        detail: `source "${s.name}" (${s.type}) has no pinned ref`,
      });
    }
    if (s.type === "registry") {
      findings.push({
        kind: "unsupported-format",
        subject: s.name,
        detail: `source type "registry" is not resolvable yet`,
      });
    }
  }

  const bySkill = new Map<string, ExternalSkillLockEntry[]>();
  for (const e of lock.entries) {
    (bySkill.get(e.skill) ?? bySkill.set(e.skill, []).get(e.skill)!).push(e);
  }
  for (const [skill, es] of bySkill) {
    if (es.length > 1) {
      const srcs = [...new Set(es.map((e) => e.source))].sort();
      if (srcs.length > 1) {
        findings.push({
          kind: "duplicate-name",
          subject: skill,
          detail: `skill "${skill}" imported from multiple sources: ${srcs.join(", ")}`,
        });
      }
    }
  }

  for (const e of lock.entries) {
    if (!e.license) {
      findings.push({
        kind: "missing-license",
        subject: e.skill,
        detail: `imported skill "${e.skill}" (from ${e.source}) has no license`,
      });
    }
    const disk = onDiskChecksum(e.skill);
    if (disk !== null && disk !== e.checksum) {
      findings.push({
        kind: "stale-copy",
        subject: e.skill,
        detail: `on-disk "${e.skill}" drifted from lock (re-run sync)`,
      });
    }
  }

  return findings.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)
  );
}

/**
 * Recompute the checksum of an imported skill's on-disk body (`instructions.md`)
 * so {@link auditExternal} can compare it to the lock and flag a `stale-copy`
 * when the package was hand-edited after import. Returns null when the skill or
 * its body is absent. The hash domain matches {@link normalizePackage}.
 */
export function importedChecksum(
  workspaceDir: string,
  skill: string
): string | null {
  try {
    const body = readFileSync(
      join(skillDir(workspaceDir, skill), "instructions.md"),
      "utf8"
    );
    return checksum(body);
  } catch {
    return null;
  }
}
