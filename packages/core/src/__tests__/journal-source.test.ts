import { describe, expect, it } from "vitest";
import { selectCandidate, forbiddenTermsFor } from "../journal-source.js";
import { hashContent, recentlyPosted } from "../journal-ledger.js";
import type { MemoryRecord } from "../memory.js";

const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: "m1",
  content: "c",
  scope: [],
  confidence: 0.5,
  trust: "trusted",
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  useCount: 0,
  ...over,
});

describe("selectCandidate", () => {
  const now = new Date("2026-06-20T00:00:00.000Z");
  it("picks the highest-confidence active journal-worthy record not yet posted", () => {
    const recs = [
      rec({ id: "a", category: "gotcha", confidence: 0.4 }),
      rec({ id: "b", category: "gotcha", confidence: 0.9 }),
      rec({ id: "c", category: "convention", confidence: 0.99 }), // wrong category
    ];
    const pick = selectCandidate(recs, {
      categories: ["gotcha", "dead-end"],
      postedIds: new Set(),
      now,
    });
    expect(pick?.id).toBe("b");
  });
  it("excludes already-posted ids and returns null when none qualify", () => {
    const recs = [rec({ id: "b", category: "gotcha", confidence: 0.9 })];
    expect(
      selectCandidate(recs, {
        categories: ["gotcha"],
        postedIds: new Set(["b"]),
        now,
      })
    ).toBeNull();
  });
  it("skips stale (expired) records", () => {
    const recs = [
      rec({
        id: "old",
        category: "gotcha",
        confidence: 0.99,
        expiresAt: "2026-06-10T00:00:00.000Z",
      }),
    ];
    expect(
      selectCandidate(recs, { categories: ["gotcha"], postedIds: new Set(), now })
    ).toBeNull();
  });
});

describe("forbiddenTermsFor", () => {
  it("collects scope globs, taskKey and run id as terms", () => {
    const terms = forbiddenTermsFor(
      rec({ scope: ["packages/core/**"], taskKey: "issue-42", sourceRun: "run-7" })
    );
    expect(terms).toContain("issue-42");
    expect(terms).toContain("run-7");
    expect(terms.some((t) => t.includes("core"))).toBe(true);
  });
});

describe("ledger", () => {
  it("hashContent is stable + recentlyPosted respects the window", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    const ledger = [
      { memoryId: "m", contentHash: "h", postedAt: "2026-06-19T00:00:00.000Z" },
    ];
    expect(recentlyPosted(ledger, 1, new Date("2026-06-19T12:00:00.000Z"))).toBe(
      true
    );
    expect(recentlyPosted(ledger, 1, new Date("2026-06-21T00:00:00.000Z"))).toBe(
      false
    );
  });
});
