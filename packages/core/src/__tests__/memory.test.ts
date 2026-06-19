import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateMemoryId,
  detectConflicts,
  listMemoryIds,
  memoryDir,
  memoryRecordPath,
  memoryStatus,
  parseMemoryRecord,
  readMemoryRecord,
  readMemoryRecords,
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
