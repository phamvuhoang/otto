import { describe, expect, it } from "vitest";

import {
  emptyReadLedger,
  fingerprintContent,
  formatReadReference,
  recordRead,
  summarizeReads,
  type DedupResult,
} from "../read-dedup.js";

describe("fingerprintContent", () => {
  it("is deterministic for identical content", () => {
    expect(fingerprintContent("hello world")).toBe(
      fingerprintContent("hello world")
    );
  });

  it("differs for different content", () => {
    expect(fingerprintContent("a")).not.toBe(fingerprintContent("b"));
  });

  it("embeds the length so different-length content never collides", () => {
    // Different lengths → the length prefix differs regardless of the hash.
    expect(fingerprintContent("abc").split("-")[0]).toBe("3");
    expect(fingerprintContent("").split("-")[0]).toBe("0");
  });
});

describe("recordRead", () => {
  it("reports the first read of a path as `first` (nothing saved yet)", () => {
    const { ledger, result } = recordRead(emptyReadLedger(), "issue.json", "X");
    expect(result.status).toBe("first");
    expect(result.savedChars).toBe(0);
    expect(result.chars).toBe(1);
    expect(ledger.seen["issue.json"].fingerprint).toBe(fingerprintContent("X"));
  });

  it("reports an unchanged re-read as `unchanged` and saves its full chars", () => {
    const content = "unchanged body of some length";
    const first = recordRead(emptyReadLedger(), "head.diff", content);
    const second = recordRead(first.ledger, "head.diff", content);
    expect(second.result.status).toBe("unchanged");
    expect(second.result.savedChars).toBe(content.length);
  });

  it("reports changed content as `changed` and saves nothing", () => {
    const first = recordRead(emptyReadLedger(), "head.diff", "v1");
    const second = recordRead(first.ledger, "head.diff", "v2-longer");
    expect(second.result.status).toBe("changed");
    expect(second.result.savedChars).toBe(0);
    // The ledger now tracks the new fingerprint, so a third identical read dedups.
    const third = recordRead(second.ledger, "head.diff", "v2-longer");
    expect(third.result.status).toBe("unchanged");
  });

  it("is pure — it does not mutate the input ledger", () => {
    const ledger = emptyReadLedger();
    recordRead(ledger, "a.txt", "content");
    expect(ledger.seen).toEqual({});
  });

  it("tracks distinct paths independently", () => {
    const first = recordRead(emptyReadLedger(), "a.txt", "same");
    const second = recordRead(first.ledger, "b.txt", "same");
    // Same content, different path → still a first read for b.txt.
    expect(second.result.status).toBe("first");
  });
});

describe("summarizeReads", () => {
  it("tallies statuses and total saved chars", () => {
    const results: DedupResult[] = [
      { path: "a", status: "first", fingerprint: "x", chars: 10, savedChars: 0 },
      {
        path: "b",
        status: "unchanged",
        fingerprint: "y",
        chars: 20,
        savedChars: 20,
      },
      {
        path: "c",
        status: "unchanged",
        fingerprint: "z",
        chars: 5,
        savedChars: 5,
      },
      {
        path: "d",
        status: "changed",
        fingerprint: "w",
        chars: 7,
        savedChars: 0,
      },
    ];
    expect(summarizeReads(results)).toEqual({
      total: 4,
      first: 1,
      unchanged: 2,
      changed: 1,
      savedChars: 25,
    });
  });

  it("is empty-safe", () => {
    expect(summarizeReads([])).toEqual({
      total: 0,
      first: 0,
      unchanged: 0,
      changed: 0,
      savedChars: 0,
    });
  });
});

describe("formatReadReference", () => {
  it("renders a short reference citing the path, savings, and re-use location", () => {
    const result: DedupResult = {
      path: "issue.json",
      status: "unchanged",
      fingerprint: "x",
      chars: 1234,
      savedChars: 1234,
    };
    const out = formatReadReference(result, { refPath: "./spill/issue.json" });
    expect(out).toContain("issue.json");
    expect(out).toContain("1234");
    expect(out).toContain("./spill/issue.json");
  });
});
