# Issue #42 — Governed memory lifecycle (P3)

## Problem

Otto's repo learning lives in one append-only file, `.otto/LEARNINGS.md`. It has
no provenance (which run/task produced an entry), no freshness (entries never
expire or get revalidated), no scope (an entry written for one module is fed to
every run), and no contradiction handling (a newer learning cannot mark an older
one stale). The blob grows unbounded and is injected wholesale into every stage,
so stale or untrusted assumptions contaminate unrelated future runs and prompt
size from memory is neither bounded nor explainable.

## Approach

Introduce **structured memory records** under `.otto/memory/` as the governed
source of truth, while `.otto/LEARNINGS.md` stays the human-readable projection.
Each record is a single JSON file (`.otto/memory/<id>.json`) carrying the
governance fields the issue names: source run, task key, file/module scope,
confidence, trust level, status, supersede pointer, timestamps, use counter, and
an expiry/revalidate policy. The **directory is the list** — there is no central
index to keep in sync (mirrors `.otto/runs/<id>/stages/` in `run-report.ts`).

The feature is built as pure substrate first and wired in later slices, exactly
like the P0/P1/P2 substrates (`run-report.ts` #39, `eval.ts` #40, `risk.ts`
#41): each slice ships a deterministic, CI-safe module that is **inert** (exported
from `index.ts`, imported by no bin/loop) until a later slice wires it. This is
why the substrate cannot regress existing runs.

Slices (see plan.md):

1. **Data substrate** — `memory.ts`: `MemoryRecord` type + field enums,
   `allocateMemoryId`, path helpers, and safe read/write/list/parse (absent or
   malformed → `null`/`[]`, never throws). Inert. *(this run)*
2. **Freshness** — pure `memoryStatus(record, now)` deriving active/stale from
   the expiry/revalidate policy; `touchMemory` to bump `lastUsedAt`/`useCount`.
3. **Contradiction handling** — pure `supersede(newer, older)` and
   `detectConflicts(records)` (same scope + category, conflicting content).
4. **Audit** — pure `auditMemory(records, now)` → an `AuditReport` of stale,
   conflicting, and frequently-used records.
5. **`otto-memory` bin** — `runMemory(argv, deps)` with an `audit` subcommand
   rendering the report (mirrors `otto-inspect`/`runInspect`).
6. **LEARNINGS projection + compaction** — project active records into the
   human-readable `LEARNINGS.md` and document the compaction tiers (active
   context / summarized state / reconstructable artifacts / durable memory).
7. **Docs** — README + ARCHITECTURE.

## Assumptions

Played both sides of a brainstorm; chosen defaults below (no human in the loop).

- **Storage layout?** → one JSON file per record under `.otto/memory/<id>.json`,
  directory-is-the-list. *Rationale:* identical to `run-report.ts`' `stages/`;
  no two-source sync; git-friendly per-record diffs.
- **Git-tracked or scratch?** → `.otto/memory/` is git-tracked (durable), like
  `LEARNINGS.md`/`verdicts.md`, NOT `.otto-tmp/`. *Rationale:* memory must
  survive across runs and machines; the issue explicitly names `.otto/memory/`.
- **Relationship to LEARNINGS.md?** → records are the governed source; a later
  slice projects active records into LEARNINGS.md as the human view. This run is
  additive and inert, so LEARNINGS.md is untouched. *Rationale:* the issue says
  "preserving `.otto/LEARNINGS.md` as the human-readable projection".
- **Field set?** → exactly the issue's list plus the minimum to make them work:
  `id`, `content`, `category`, `sourceRun`, `taskKey`, `scope[]`, `confidence`
  (0..1), `trust`, `status`, `supersedes`, `createdAt`, `lastUsedAt`,
  `useCount`, `expiresAt`, `revalidateAfterDays`. *Rationale:* YAGNI — nothing
  speculative beyond what slices 2–4 consume.
- **Trust vocabulary?** → `trusted | unverified | deprecated`; `status` is
  `active | stale | superseded`. *Rationale:* trust = provenance band (coarse);
  confidence = a 0..1 scalar; status = lifecycle. Three orthogonal axes the
  issue calls for ("confidence … trust level", "supersede or mark older stale").
- **Memory id shape?** → `allocateMemoryId(date, suffix)` = sortable ISO stamp
  (`:`/`.`→`-`) + `-<suffix>`, injectable for deterministic tests, mirroring
  `allocateRunId`. *Rationale:* lexicographically sortable so "newest" is a
  string sort; suffix (pid or a per-record discriminator) avoids same-ms
  collisions.
- **Malformed/absent handling?** → every reader returns a safe empty value and
  never throws (mirrors `state.ts`/`run-report.ts`). *Rationale:* a memory read
  must never break a run.

## Testing notes

- Pure module, no model calls → fully unit-testable and CI-safe (vitest).
- `memory.test.ts` pins: `allocateMemoryId` (sortable/safe/suffixed), path
  helpers, `parseMemoryRecord` defaulting + rejection of non-objects, round-trip
  write→read, `listMemoryIds`/`readMemoryRecords` sorted + absent→`[]` +
  malformed-skipped.
- Later slices add their own deterministic tests; the audit/bin slices get a
  root contract test (`scripts/*.test.mjs`) through the published package, like
  the eval/run-report suites.
