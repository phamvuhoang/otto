# Issue #42 — Governed memory lifecycle: plan

Bite-sized, testable slices. Each ships a deterministic, CI-safe module that is
inert (exported, unwired) until a later slice consumes it — so no slice can
regress existing runs.

- [x] **1. Data substrate (`memory.ts`).** `MemoryRecord` type + `MemoryTrust`/
      `MemoryStatus` enums; `allocateMemoryId(date, suffix)`; `memoryDir`/path
      helpers; `parseMemoryRecord` (safe defaults, rejects non-objects);
      `writeMemoryRecord`/`readMemoryRecord`/`listMemoryIds`/`readMemoryRecords`
      (absent/malformed → `null`/`[]`, never throws). Export from `index.ts`.
      Inert. Pinned by `memory.test.ts`. *(this run)*
- [x] **2. Freshness policy.** Pure `memoryStatus(record, now)` deriving
      `active`/`stale` from `expiresAt`/`revalidateAfterDays` vs `now`/`createdAt`/
      `lastUsedAt`; `touchMemory(record, now)` bumping `lastUsedAt`/`useCount`.
      Inert. Pinned by `memory.test.ts`. *(this run)*
- [x] **3. Contradiction handling.** Pure `supersede(newer, older)` (sets
      `older.status="superseded"`, `newer.supersedes=older.id`) and
      `detectConflicts(records)` (same `scope`+`category`, both `active`,
      different `content`). Inert. Pinned by `memory.test.ts`. *(this run)*
- [x] **4. Audit.** Pure `auditMemory(records, now)` → `AuditReport`
      (`stale[]`, `conflicting[]`, `frequentlyUsed[]`, counts). Inert. Pinned by
      `memory.test.ts`. *(this run)*
- [ ] **5. `otto-memory` bin.** `runMemory(argv, deps)` with an `audit`
      subcommand → `formatAuditReport(report)`, mirroring `runInspect`. Wire
      `apps/cli/bin/otto-memory.js` + `package.json` `bin`. Pinned by
      `memory.test.ts` + a root contract test.
- [ ] **6. LEARNINGS projection + compaction rules.** Project active records to
      the human-readable `LEARNINGS.md` view; document the compaction tiers
      (active context / summarized state / reconstructable artifacts / durable
      memory). Define how a run writes a record on a new learning.
- [ ] **7. Docs.** README feature bullet + `otto-memory audit` example;
      ARCHITECTURE module rows + a "Governed memory lifecycle" section.
