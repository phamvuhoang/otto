import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateMemoryId,
  listMemoryIds,
  memoryDir,
  memoryRecordPath,
  parseMemoryRecord,
  readMemoryRecord,
  readMemoryRecords,
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
  createdAt: "2026-06-19T00:00:00.000Z",
  useCount: 0,
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
