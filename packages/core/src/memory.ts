import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Coarse provenance band for a memory record. `trusted` = verified or maintainer
 * blessed; `unverified` = produced by a run but not yet confirmed; `deprecated`
 * = kept for history but should no longer influence a run. Orthogonal to the
 * numeric {@link MemoryRecord.confidence}.
 */
export type MemoryTrust = "trusted" | "unverified" | "deprecated";

/**
 * Lifecycle state. `active` = eligible to inform a run; `stale` = past its
 * freshness policy and awaiting revalidation; `superseded` = replaced by a newer
 * record (see {@link MemoryRecord.supersedes}).
 */
export type MemoryStatus = "active" | "stale" | "superseded";

/**
 * One governed memory entry, stored as `.otto/memory/<id>.json`. Carries the
 * provenance/freshness/scope fields that let Otto treat repo learning as
 * governed state rather than an append-only prompt blob (issue #42). The
 * `.otto/memory/` directory is the list — there is no central index.
 */
export type MemoryRecord = {
  id: string;
  /** The durable learning text (the projection into `LEARNINGS.md`). */
  content: string;
  /** Section bucket, mirroring LEARNINGS.md (convention/gotcha/decision/dead-end). */
  category?: string;
  /** Run id that produced this record. */
  sourceRun?: string;
  /** Task key scope (e.g. "issue-42") this learning came from. */
  taskKey?: string;
  /** File/module globs this learning applies to; empty = repo-wide. */
  scope: string[];
  /** Subjective confidence in the learning, clamped to [0,1]. */
  confidence: number;
  trust: MemoryTrust;
  status: MemoryStatus;
  /** Id of the older record this one replaces, when it supersedes one. */
  supersedes?: string;
  createdAt: string;
  /** Last time a run consumed this record. */
  lastUsedAt?: string;
  /** How many runs have consumed this record. */
  useCount: number;
  /** Absolute expiry instant (ISO); past it the record is stale. */
  expiresAt?: string;
  /** Sliding freshness window in days from `createdAt`/`lastUsedAt`. */
  revalidateAfterDays?: number;
};

const TRUSTS: ReadonlySet<string> = new Set([
  "trusted",
  "unverified",
  "deprecated",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "active",
  "stale",
  "superseded",
]);

/**
 * Allocate a sortable, filesystem-safe memory id: an ISO timestamp with its
 * colons/periods replaced by dashes, suffixed to avoid same-instant collisions.
 * Lexicographic order matches chronological order, so "newest" is a plain string
 * sort. `date`/`suffix` are injectable so tests are deterministic; pass a unique
 * suffix (pid plus a per-record counter) when writing several records in one run.
 */
export function allocateMemoryId(
  date: Date = new Date(),
  suffix: string | number = process.pid
): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${suffix}`;
}

const MEMORY_REL = join(".otto", "memory");

/** Absolute path to the workspace's memory root (`.otto/memory`). */
export function memoryDir(workspaceDir: string): string {
  return join(workspaceDir, MEMORY_REL);
}

/** Absolute path to one record's file (`.otto/memory/<id>.json`). */
export function memoryRecordPath(workspaceDir: string, id: string): string {
  return join(memoryDir(workspaceDir), `${id}.json`);
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalize an untrusted parsed value into a {@link MemoryRecord}, filling safe
 * defaults for missing/invalid governance fields. Returns null when the input is
 * not an object or lacks the two required identity fields (`id`, `content`), so a
 * malformed file is skipped rather than crashing a read.
 */
export function parseMemoryRecord(raw: unknown): MemoryRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.content !== "string") {
    return null;
  }
  const rec: MemoryRecord = {
    id: o.id,
    content: o.content,
    scope: Array.isArray(o.scope)
      ? o.scope.filter((s): s is string => typeof s === "string")
      : [],
    confidence: clampConfidence(o.confidence),
    trust:
      typeof o.trust === "string" && TRUSTS.has(o.trust)
        ? (o.trust as MemoryTrust)
        : "unverified",
    status:
      typeof o.status === "string" && STATUSES.has(o.status)
        ? (o.status as MemoryStatus)
        : "active",
    createdAt:
      typeof o.createdAt === "string"
        ? o.createdAt
        : new Date(0).toISOString(),
    useCount:
      typeof o.useCount === "number" && Number.isFinite(o.useCount)
        ? o.useCount
        : 0,
  };
  if (typeof o.category === "string") rec.category = o.category;
  if (typeof o.sourceRun === "string") rec.sourceRun = o.sourceRun;
  if (typeof o.taskKey === "string") rec.taskKey = o.taskKey;
  if (typeof o.supersedes === "string") rec.supersedes = o.supersedes;
  if (typeof o.lastUsedAt === "string") rec.lastUsedAt = o.lastUsedAt;
  if (typeof o.expiresAt === "string") rec.expiresAt = o.expiresAt;
  if (
    typeof o.revalidateAfterDays === "number" &&
    Number.isFinite(o.revalidateAfterDays)
  ) {
    rec.revalidateAfterDays = o.revalidateAfterDays;
  }
  return rec;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO timestamp to epoch ms; unparseable → null (never throws). */
function epoch(iso: string | undefined): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Derive a record's effective lifecycle status from its freshness policy at the
 * given instant. `superseded` is terminal (set by contradiction handling) and is
 * preserved untouched. Otherwise the record is `stale` once it has reached its
 * absolute `expiresAt`, or once `revalidateAfterDays` have elapsed since it was
 * last used (`lastUsedAt`, falling back to `createdAt`); else `active`.
 * Unparseable timestamps are ignored rather than treated as expired. Pure.
 */
export function memoryStatus(
  record: MemoryRecord,
  now: Date = new Date()
): MemoryStatus {
  if (record.status === "superseded") return "superseded";
  const t = now.getTime();
  const expiry = epoch(record.expiresAt);
  if (expiry !== null && t >= expiry) return "stale";
  if (record.revalidateAfterDays !== undefined) {
    const since = epoch(record.lastUsedAt) ?? epoch(record.createdAt);
    if (since !== null && t - since > record.revalidateAfterDays * DAY_MS) {
      return "stale";
    }
  }
  return "active";
}

/**
 * Return a copy of the record marked as just used: `lastUsedAt` stamped at `now`
 * and `useCount` incremented. Pure — the input is not mutated. A run calls this
 * when it consumes a record, sliding the revalidation window forward.
 */
export function touchMemory(
  record: MemoryRecord,
  now: Date = new Date()
): MemoryRecord {
  return {
    ...record,
    lastUsedAt: now.toISOString(),
    useCount: record.useCount + 1,
  };
}

/** The two record copies produced by {@link supersede}. */
export type Supersession = { newer: MemoryRecord; older: MemoryRecord };

/**
 * Record that `newer` replaces `older`: returns copies with `older.status` set to
 * `superseded` (terminal — {@link memoryStatus} preserves it) and `newer.supersedes`
 * pointing at `older.id`. Pure — neither input is mutated. The caller writes both
 * copies back to persist the contradiction.
 */
export function supersede(
  newer: MemoryRecord,
  older: MemoryRecord
): Supersession {
  return {
    newer: { ...newer, supersedes: older.id },
    older: { ...older, status: "superseded" },
  };
}

/** Group key for conflict detection: same category + same scope set. */
function conflictKey(record: MemoryRecord): string {
  const scope = [...record.scope].sort().join(" ");
  return `${record.category ?? ""}${scope}`;
}

/**
 * Find pairs of records that contradict each other: both `active`, the same
 * `category` and `scope` set (order-independent), but different `content`. Returns
 * each conflicting pair in input order; identical content is agreement, not
 * conflict, and non-`active` records are ignored. Pure.
 */
export function detectConflicts(
  records: MemoryRecord[]
): [MemoryRecord, MemoryRecord][] {
  const active = records.filter((r) => r.status === "active");
  const conflicts: [MemoryRecord, MemoryRecord][] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.content !== b.content && conflictKey(a) === conflictKey(b)) {
        conflicts.push([a, b]);
      }
    }
  }
  return conflicts;
}

/** Default `useCount` at or above which a record is "frequently used". */
export const DEFAULT_FREQUENT_USE = 5;

/**
 * A governance snapshot of a memory set: which records are stale, which pairs
 * contradict each other, which are heavily relied upon, plus a count breakdown.
 * Produced by {@link auditMemory}; rendered by the `otto-memory audit` bin.
 */
export type AuditReport = {
  /** Records whose DERIVED freshness status is `stale` (past expiry/revalidation). */
  stale: MemoryRecord[];
  /** Conflicting pairs (same scope+category, different content) — see {@link detectConflicts}. */
  conflicting: [MemoryRecord, MemoryRecord][];
  /** Records used at least the threshold number of times, most-used first. */
  frequentlyUsed: MemoryRecord[];
  counts: {
    total: number;
    active: number;
    stale: number;
    superseded: number;
    /** Number of conflicting PAIRS, not records. */
    conflicting: number;
    frequentlyUsed: number;
  };
};

/**
 * Audit a memory set at `now`: surface stale, conflicting, and frequently-used
 * records so a maintainer can spot governance problems before they influence a
 * run. Pure. Two intentionally different status sources: `stale` (and the
 * active/stale/superseded counts) use the DERIVED {@link memoryStatus} so a
 * record past its freshness policy is caught even if its stored status still says
 * `active`; `conflicting` delegates to {@link detectConflicts}, which uses the
 * STORED status (time-free). `frequentlyUsed` lists records with
 * `useCount >= frequentThreshold`, most-used first, ties broken by id.
 */
export function auditMemory(
  records: MemoryRecord[],
  now: Date = new Date(),
  frequentThreshold: number = DEFAULT_FREQUENT_USE
): AuditReport {
  const stale: MemoryRecord[] = [];
  let active = 0;
  let superseded = 0;
  for (const r of records) {
    const s = memoryStatus(r, now);
    if (s === "stale") stale.push(r);
    else if (s === "superseded") superseded++;
    else active++;
  }
  const conflicting = detectConflicts(records);
  const frequentlyUsed = records
    .filter((r) => r.useCount >= frequentThreshold)
    .sort((a, b) => b.useCount - a.useCount || (a.id < b.id ? -1 : 1));
  return {
    stale,
    conflicting,
    frequentlyUsed,
    counts: {
      total: records.length,
      active,
      stale: stale.length,
      superseded,
      conflicting: conflicting.length,
      frequentlyUsed: frequentlyUsed.length,
    },
  };
}

/** Write one memory record (creates `.otto/memory/`). */
export function writeMemoryRecord(
  workspaceDir: string,
  record: MemoryRecord
): void {
  const p = memoryRecordPath(workspaceDir, record.id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + "\n");
}

/** Read one record by id. Absent/malformed → null (never throws). */
export function readMemoryRecord(
  workspaceDir: string,
  id: string
): MemoryRecord | null {
  try {
    return parseMemoryRecord(
      JSON.parse(readFileSync(memoryRecordPath(workspaceDir, id), "utf8"))
    );
  } catch {
    return null;
  }
}

/**
 * List the memory ids present under `.otto/memory/`, sorted ascending. Because
 * ids are lexicographically sortable (see {@link allocateMemoryId}), the last
 * entry is the newest. Absent/unreadable dir → `[]` (never throws).
 */
export function listMemoryIds(workspaceDir: string): string[] {
  try {
    return readdirSync(memoryDir(workspaceDir))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read every memory record in id (chronological) order. Absent dir → `[]`; a
 * malformed file is skipped rather than failing the whole read (never throws).
 */
export function readMemoryRecords(workspaceDir: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const id of listMemoryIds(workspaceDir)) {
    const rec = readMemoryRecord(workspaceDir, id);
    if (rec) records.push(rec);
  }
  return records;
}
