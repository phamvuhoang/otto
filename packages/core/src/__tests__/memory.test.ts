import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateMemoryId,
  auditMemory,
  boundLearnings,
  DEFAULT_LEARNINGS_BUDGET_CHARS,
  detectConflicts,
  formatBoundedLearnings,
  listMemoryIds,
  memoryDir,
  memoryRecordPath,
  memoryStatus,
  parseMemoryRecord,
  projectLearnings,
  readMemoryRecord,
  readMemoryRecords,
  selectRelevantMemory,
  supersede,
  touchMemory,
  writeMemoryRecord,
  type MemoryRecord,
} from "../memory.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-memory-"));
}

const record: MemoryRecord = {
  id: "2026-06-19T00-00-00-000Z-42-0",
  content: "Relative imports in packages/core/src end in .js (NodeNext).",
  category: "convention",
  sourceRun: "2026-06-19T00-00-00-000Z-42",
  taskKey: "issue-42",
  scope: ["packages/core/src/**"],
  confidence: 0.9,
  trust: "trusted",
  status: "active",
  supersedes: "2026-06-18T00-00-00-000Z-41-0",
  createdAt: "2026-06-19T00:00:00.000Z",
  lastUsedAt: "2026-06-19T01:00:00.000Z",
  useCount: 0,
  expiresAt: "2026-12-19T00:00:00.000Z",
  revalidateAfterDays: 30,
};

describe("allocateMemoryId", () => {
  it("is sortable, filesystem-safe, and suffixed", () => {
    const id = allocateMemoryId(new Date("2026-06-19T12:34:56.789Z"), "42-7");
    expect(id).toBe("2026-06-19T12-34-56-789Z-42-7");
    expect(id).not.toMatch(/[:.]/);
  });
  it("sorts chronologically as a plain string", () => {
    const a = allocateMemoryId(new Date("2026-06-19T00:00:00.000Z"), "1");
    const b = allocateMemoryId(new Date("2026-06-19T00:00:01.000Z"), "1");
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe("path helpers", () => {
  it("compose under .otto/memory/", () => {
    expect(memoryDir("/ws")).toBe(join("/ws", ".otto", "memory"));
    expect(memoryRecordPath("/ws", "mid")).toBe(
      join("/ws", ".otto", "memory", "mid.json")
    );
  });
});

describe("parseMemoryRecord", () => {
  it("fills safe defaults for a minimal object", () => {
    const r = parseMemoryRecord({ id: "x", content: "y" });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      id: "x",
      content: "y",
      trust: "unverified",
      status: "active",
      confidence: 0.5,
      scope: [],
      useCount: 0,
    });
  });
  it("preserves provided governance fields", () => {
    const r = parseMemoryRecord(record);
    expect(r).toEqual(record);
  });
  it("rejects non-objects and records missing id/content", () => {
    expect(parseMemoryRecord(null)).toBeNull();
    expect(parseMemoryRecord("nope")).toBeNull();
    expect(parseMemoryRecord({ content: "no id" })).toBeNull();
    expect(parseMemoryRecord({ id: "no content" })).toBeNull();
  });
  it("clamps an out-of-range confidence into [0,1]", () => {
    expect(parseMemoryRecord({ id: "a", content: "b", confidence: 5 })?.confidence).toBe(1);
    expect(parseMemoryRecord({ id: "a", content: "b", confidence: -2 })?.confidence).toBe(0);
  });
  it("drops an invalid trust/status to the default", () => {
    const r = parseMemoryRecord({ id: "a", content: "b", trust: "bogus", status: "weird" });
    expect(r?.trust).toBe("unverified");
    expect(r?.status).toBe("active");
  });
});

describe("memoryStatus (freshness)", () => {
  const base: MemoryRecord = {
    ...record,
    status: "active",
    expiresAt: undefined,
    revalidateAfterDays: undefined,
    lastUsedAt: undefined,
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  it("a record with no freshness policy is active", () => {
    expect(memoryStatus(base, new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "active"
    );
  });

  it("expiresAt in the past → stale, in the future → active", () => {
    const r = { ...base, expiresAt: "2026-07-01T00:00:00.000Z" };
    expect(memoryStatus(r, new Date("2026-08-01T00:00:00.000Z"))).toBe("stale");
    expect(memoryStatus(r, new Date("2026-06-15T00:00:00.000Z"))).toBe(
      "active"
    );
  });

  it("reaching the expiry instant counts as stale", () => {
    const r = { ...base, expiresAt: "2026-07-01T00:00:00.000Z" };
    expect(memoryStatus(r, new Date("2026-07-01T00:00:00.000Z"))).toBe("stale");
  });

  it("revalidateAfterDays elapsed since lastUsedAt → stale", () => {
    const r = {
      ...base,
      lastUsedAt: "2026-06-10T00:00:00.000Z",
      revalidateAfterDays: 30,
    };
    // 31 days after lastUsedAt
    expect(memoryStatus(r, new Date("2026-07-11T00:00:00.000Z"))).toBe("stale");
    // 10 days after lastUsedAt
    expect(memoryStatus(r, new Date("2026-06-20T00:00:00.000Z"))).toBe(
      "active"
    );
  });

  it("revalidation window measures from createdAt when lastUsedAt is absent", () => {
    const r = {
      ...base,
      createdAt: "2026-06-01T00:00:00.000Z",
      revalidateAfterDays: 10,
    };
    expect(memoryStatus(r, new Date("2026-06-15T00:00:00.000Z"))).toBe("stale");
    expect(memoryStatus(r, new Date("2026-06-05T00:00:00.000Z"))).toBe(
      "active"
    );
  });

  it("a superseded record stays superseded regardless of freshness", () => {
    const r = { ...base, status: "superseded" as const };
    expect(memoryStatus(r, new Date("2026-06-02T00:00:00.000Z"))).toBe(
      "superseded"
    );
  });

  it("ignores an unparseable timestamp rather than throwing", () => {
    const r = {
      ...base,
      expiresAt: "not-a-date",
      revalidateAfterDays: 5,
      lastUsedAt: "also-bad",
      createdAt: "still-bad",
    };
    expect(memoryStatus(r, new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "active"
    );
  });
});

describe("touchMemory", () => {
  it("bumps useCount and stamps lastUsedAt without mutating the input", () => {
    const r: MemoryRecord = { ...record, useCount: 2 };
    const touched = touchMemory(r, new Date("2027-01-02T03:04:05.000Z"));
    expect(touched.useCount).toBe(3);
    expect(touched.lastUsedAt).toBe("2027-01-02T03:04:05.000Z");
    // original is untouched (pure)
    expect(r.useCount).toBe(2);
    expect(r.lastUsedAt).toBe(record.lastUsedAt);
  });
});

describe("supersede", () => {
  it("marks older superseded and points newer at it, without mutating inputs", () => {
    const older: MemoryRecord = {
      ...record,
      id: "old",
      status: "active",
      supersedes: undefined,
    };
    const newer: MemoryRecord = {
      ...record,
      id: "new",
      content: "newer text",
      status: "active",
      supersedes: undefined,
    };
    const { newer: n, older: o } = supersede(newer, older);
    expect(o.status).toBe("superseded");
    expect(n.supersedes).toBe("old");
    // newer keeps its own status; only its supersedes pointer changes
    expect(n.status).toBe("active");
    // inputs are untouched (pure — returns copies)
    expect(older.status).toBe("active");
    expect(newer.supersedes).toBeUndefined();
  });
});

describe("detectConflicts", () => {
  const active = (over: Partial<MemoryRecord>): MemoryRecord => ({
    ...record,
    status: "active",
    ...over,
  });

  it("flags two active records with same scope+category but different content", () => {
    const a = active({ id: "a", content: "X" });
    const b = active({ id: "b", content: "Y" });
    const conflicts = detectConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not flag identical content (agreement, not conflict)", () => {
    const a = active({ id: "a", content: "same" });
    const b = active({ id: "b", content: "same" });
    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("does not flag records in different scope or category", () => {
    const a = active({ id: "a", content: "X", scope: ["src/a/**"] });
    const b = active({ id: "b", content: "Y", scope: ["src/b/**"] });
    const c = active({ id: "c", content: "Z", category: "gotcha" });
    expect(detectConflicts([a, b, c])).toEqual([]);
  });

  it("ignores non-active records (superseded/stale do not conflict)", () => {
    const a = active({ id: "a", content: "X" });
    const b = active({ id: "b", content: "Y", status: "superseded" });
    const c = active({ id: "c", content: "Z", status: "stale" });
    expect(detectConflicts([a, b, c])).toEqual([]);
  });

  it("treats scope as an order-independent set", () => {
    const a = active({ id: "a", content: "X", scope: ["p", "q"] });
    const b = active({ id: "b", content: "Y", scope: ["q", "p"] });
    expect(detectConflicts([a, b])).toHaveLength(1);
  });
});

describe("auditMemory", () => {
  // createdAt/lastUsedAt 2026-06-19; expiresAt 2026-12-19; revalidateAfterDays 30.
  const fresh = new Date("2026-06-19T02:00:00.000Z"); // within every window
  const expired = new Date("2027-01-01T00:00:00.000Z"); // past expiresAt

  const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
    ...record,
    status: "active",
    ...over,
  });

  it("empty input → empty report with zero counts", () => {
    expect(auditMemory([], fresh)).toEqual({
      stale: [],
      conflicting: [],
      frequentlyUsed: [],
      counts: {
        total: 0,
        active: 0,
        stale: 0,
        superseded: 0,
        conflicting: 0,
        frequentlyUsed: 0,
      },
    });
  });

  it("classifies stale by DERIVED status, not the stored field", () => {
    // stored status is active, but it has passed expiresAt at `expired`
    const r = rec({ id: "a", useCount: 0 });
    const report = auditMemory([r], expired);
    expect(report.stale.map((x) => x.id)).toEqual(["a"]);
    expect(report.counts).toMatchObject({ total: 1, active: 0, stale: 1 });
  });

  it("counts superseded separately and excludes it from stale", () => {
    const r = rec({ id: "s", status: "superseded" });
    const report = auditMemory([r], expired);
    expect(report.stale).toEqual([]);
    expect(report.counts).toMatchObject({
      total: 1,
      active: 0,
      stale: 0,
      superseded: 1,
    });
  });

  it("surfaces conflicting pairs (delegates to detectConflicts)", () => {
    const a = rec({ id: "a", content: "X" });
    const b = rec({ id: "b", content: "Y" });
    const report = auditMemory([a, b], fresh);
    expect(report.conflicting).toHaveLength(1);
    expect(report.conflicting[0].map((r) => r.id)).toEqual(["a", "b"]);
    expect(report.counts.conflicting).toBe(1);
  });

  it("lists frequently-used records (>= threshold) most-used first", () => {
    const lo = rec({ id: "lo", content: "L", useCount: 2 });
    const hi = rec({ id: "hi", content: "H", useCount: 9 });
    const mid = rec({ id: "mid", content: "M", useCount: 5 });
    const report = auditMemory([lo, hi, mid], fresh, 5);
    expect(report.frequentlyUsed.map((r) => r.id)).toEqual(["hi", "mid"]);
    expect(report.counts.frequentlyUsed).toBe(2);
  });

  it("breaks useCount ties by id for determinism", () => {
    const a = rec({ id: "b", content: "X", useCount: 7 });
    const b = rec({ id: "a", content: "Y", useCount: 7 });
    const report = auditMemory([a, b], fresh, 5);
    expect(report.frequentlyUsed.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("uses the default frequency threshold when none is given", () => {
    const r = rec({ id: "a", useCount: 5 });
    expect(auditMemory([r], fresh).frequentlyUsed.map((x) => x.id)).toEqual([
      "a",
    ]);
    expect(
      auditMemory([rec({ id: "b", useCount: 4 })], fresh).frequentlyUsed
    ).toEqual([]);
  });

  it("frequentlyUsed is status-independent (stale/superseded still listed)", () => {
    // derived-stale (past expiresAt) and superseded records, both heavily used:
    // they appear in BOTH frequentlyUsed and their stale/superseded list/count.
    const old = rec({ id: "old", content: "O", useCount: 9 });
    const sup = rec({ id: "sup", content: "S", status: "superseded", useCount: 8 });
    const report = auditMemory([old, sup], expired, 5);
    expect(report.frequentlyUsed.map((x) => x.id)).toEqual(["old", "sup"]);
    expect(report.counts.frequentlyUsed).toBe(2);
    // and they are not filtered out of their lifecycle buckets
    expect(report.stale.map((x) => x.id)).toEqual(["old"]);
    expect(report.counts).toMatchObject({ stale: 1, superseded: 1 });
  });
});

describe("projectLearnings", () => {
  // createdAt/lastUsedAt 2026-06-19; expiresAt 2026-12-19; revalidateAfterDays 30.
  const fresh = new Date("2026-06-19T02:00:00.000Z"); // within every window
  const expired = new Date("2027-01-01T00:00:00.000Z"); // past expiresAt

  const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
    ...record,
    status: "active",
    ...over,
  });

  it("empty input → the four canonical sections under the H1", () => {
    expect(projectLearnings([], fresh)).toBe(
      "# Otto learnings\n\n" +
        "## Conventions\n\n" +
        "## Gotchas\n\n" +
        "## Decisions\n\n" +
        "## Dead ends\n"
    );
  });

  it("groups active records by category into the right section", () => {
    const out = projectLearnings(
      [
        rec({ id: "c", content: "C1", category: "convention" }),
        rec({ id: "g", content: "G1", category: "gotcha" }),
        rec({ id: "d", content: "D1", category: "decision" }),
        rec({ id: "e", content: "E1", category: "dead-end" }),
      ],
      fresh
    );
    expect(out).toBe(
      "# Otto learnings\n\n" +
        "## Conventions\n\n- C1\n\n" +
        "## Gotchas\n\n- G1\n\n" +
        "## Decisions\n\n- D1\n\n" +
        "## Dead ends\n\n- E1\n"
    );
  });

  it("orders records within a section by id (chronological)", () => {
    const out = projectLearnings(
      [
        rec({ id: "2026-02", content: "second", category: "convention" }),
        rec({ id: "2026-01", content: "first", category: "convention" }),
      ],
      fresh
    );
    expect(out).toContain("- first\n- second");
  });

  it("maps unknown/missing category to Conventions (the catch-all)", () => {
    const out = projectLearnings(
      [
        rec({ id: "a", content: "no category", category: undefined }),
        rec({ id: "b", content: "odd category", category: "misc" }),
      ],
      fresh
    );
    expect(out).toBe(
      "# Otto learnings\n\n" +
        "## Conventions\n\n- no category\n- odd category\n\n" +
        "## Gotchas\n\n" +
        "## Decisions\n\n" +
        "## Dead ends\n"
    );
  });

  it("excludes derived-stale and superseded records (bounded to active)", () => {
    const out = projectLearnings(
      [
        rec({
          id: "ok",
          content: "keep me",
          category: "convention",
          expiresAt: undefined,
          revalidateAfterDays: undefined,
        }),
        // stored status active but past expiresAt at `expired` → derived stale
        rec({ id: "stale", content: "drop stale", category: "convention" }),
        rec({
          id: "sup",
          content: "drop superseded",
          category: "convention",
          status: "superseded",
        }),
      ],
      expired
    );
    expect(out).toContain("- keep me");
    expect(out).not.toContain("drop stale");
    expect(out).not.toContain("drop superseded");
  });
});

describe("bounded learnings injection (#62 P7 slice 5)", () => {
  // Always-active fixtures: no freshness fields, so `now` never stales them.
  const active = (over: Partial<MemoryRecord>): MemoryRecord => ({
    ...record,
    status: "active",
    expiresAt: undefined,
    revalidateAfterDays: undefined,
    ...over,
  });

  describe("selectRelevantMemory", () => {
    it("ranks task-key match > repo-wide > other-scope", () => {
      const recs = [
        active({ id: "a", taskKey: "other", scope: ["x/**"], content: "A" }),
        active({ id: "b", taskKey: "issue-62", scope: ["y/**"], content: "B" }),
        active({ id: "c", taskKey: "other", scope: [], content: "C" }),
      ];
      const ranked = selectRelevantMemory(recs, { taskKey: "issue-62" });
      expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
    });

    it("excludes derived-stale / superseded records", () => {
      const recs = [
        active({ id: "keep", content: "K" }),
        active({ id: "sup", content: "S", status: "superseded" }),
      ];
      expect(selectRelevantMemory(recs).map((r) => r.id)).toEqual(["keep"]);
    });

    it("breaks ties by confidence, then useCount, then recency (newest first)", () => {
      const recs = [
        active({ id: "2026-01", confidence: 0.5, useCount: 0, content: "X" }),
        active({ id: "2026-02", confidence: 0.5, useCount: 0, content: "Y" }),
        active({ id: "2026-00", confidence: 0.9, useCount: 0, content: "Z" }),
      ];
      // 2026-00 (highest confidence) first; then the two equal ones newest-first.
      expect(selectRelevantMemory(recs).map((r) => r.id)).toEqual([
        "2026-00",
        "2026-02",
        "2026-01",
      ]);
    });
  });

  describe("boundLearnings", () => {
    const r1 = active({ id: "r1", confidence: 0.9, content: "A".repeat(50) });
    const r2 = active({ id: "r2", confidence: 0.8, content: "B".repeat(50) });
    const r3 = active({ id: "r3", confidence: 0.7, content: "C".repeat(50) });

    it("caps the selected set at the char budget and drops the rest by rank", () => {
      const bounded = boundLearnings([r3, r1, r2], { maxChars: 120 });
      expect(bounded.selected.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(bounded.dropped.map((r) => r.id)).toEqual(["r3"]);
      expect(bounded.selectedChars).toBe(100);
      expect(bounded.droppedChars).toBe(50);
      expect(bounded.budgetChars).toBe(120);
    });

    it("selects everything when it fits, dropping nothing", () => {
      const bounded = boundLearnings([r1, r2, r3], { maxChars: 1000 });
      expect(bounded.selected).toHaveLength(3);
      expect(bounded.dropped).toEqual([]);
      expect(bounded.droppedChars).toBe(0);
    });

    it("uses the default budget when maxChars is omitted", () => {
      expect(boundLearnings([r1]).budgetChars).toBe(
        DEFAULT_LEARNINGS_BUDGET_CHARS
      );
    });
  });

  describe("formatBoundedLearnings", () => {
    const now = new Date("2026-06-19T02:00:00.000Z");
    const r1 = active({ id: "r1", confidence: 0.9, content: "A".repeat(50) });
    const r2 = active({ id: "r2", confidence: 0.8, content: "B".repeat(50) });
    const r3 = active({ id: "r3", confidence: 0.7, content: "C".repeat(50) });

    it("projects the selected set and notes what was dropped", () => {
      const bounded = boundLearnings([r1, r2, r3], { maxChars: 120 });
      const out = formatBoundedLearnings(bounded, now);
      expect(out).toContain("# Otto learnings");
      expect(out).toContain(projectLearnings(bounded.selected, now).trimEnd());
      expect(out).toContain("1 lower-relevance learning");
      expect(out).toContain("120-char");
    });

    it("renders just the projection when nothing was dropped", () => {
      const bounded = boundLearnings([r1], { maxChars: 1000 });
      expect(formatBoundedLearnings(bounded, now)).toBe(
        projectLearnings(bounded.selected, now)
      );
    });
  });
});

describe("write/read round-trip", () => {
  it("writes then reads an identical record", () => {
    const ws = tmp();
    writeMemoryRecord(ws, record);
    expect(readMemoryRecord(ws, record.id)).toEqual(record);
  });
  it("readMemoryRecord returns null for an absent id", () => {
    expect(readMemoryRecord(tmp(), "missing")).toBeNull();
  });
});

describe("listMemoryIds / readMemoryRecords", () => {
  it("absent dir → [] (never throws)", () => {
    expect(listMemoryIds(tmp())).toEqual([]);
    expect(readMemoryRecords(tmp())).toEqual([]);
  });
  it("lists ids sorted and reads records, skipping malformed files", () => {
    const ws = tmp();
    const a = { ...record, id: "2026-01-01T00-00-00-000Z-1-0" };
    const b = { ...record, id: "2026-02-01T00-00-00-000Z-1-0" };
    writeMemoryRecord(ws, b);
    writeMemoryRecord(ws, a);
    // a malformed file and a non-json file are both ignored
    writeFileSync(join(memoryDir(ws), "broken.json"), "{ not json");
    writeFileSync(join(memoryDir(ws), "notes.txt"), "ignore me");
    // listMemoryIds is a filename lister (non-.json dropped, malformed kept);
    // readMemoryRecords parses and skips the malformed one.
    expect(listMemoryIds(ws)).toEqual([a.id, b.id, "broken"]);
    expect(readMemoryRecords(ws).map((r) => r.id)).toEqual([a.id, b.id]);
  });
  it("tolerates an absent dir created lazily by write", () => {
    const ws = tmp();
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeMemoryRecord(ws, record);
    expect(listMemoryIds(ws)).toEqual([record.id]);
  });
});
