import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEARNINGS_BUDGET_CHARS,
  LEARNINGS_FALLBACK,
  learningsForPrompt,
  resolveLearningsBlock,
  writeMemoryRecord,
  type MemoryRecord,
} from "../memory.js";

// Always-active record: no freshness fields, so `now` never stales it.
const rec = (id: string, content: string, confidence = 0.9): MemoryRecord => ({
  id,
  content,
  category: "convention",
  scope: [],
  confidence,
  trust: "trusted",
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z",
  useCount: 1,
});

describe("resolveLearningsBlock", () => {
  it("passes a small file through byte-identically (trailing newline trimmed)", () => {
    const out = resolveLearningsBlock("## Gotchas\n- pnpm not npm\n", []);
    expect(out.text).toBe("## Gotchas\n- pnpm not npm");
    expect(out.bounded).toBe(false);
  });

  it("uses the exact try-shell fallback when the file is absent", () => {
    expect(resolveLearningsBlock(null, []).text).toBe(LEARNINGS_FALLBACK);
    expect(LEARNINGS_FALLBACK).toBe("_No learnings recorded yet._");
  });

  it("bounds an over-budget file from governed records, with the omission note", () => {
    const raw = "x".repeat(DEFAULT_LEARNINGS_BUDGET_CHARS + 1);
    const records = [
      rec("2026-07-02T00-00-00-000Z-a", "keep: high-value convention", 0.95),
      rec("2026-07-01T00-00-00-000Z-b", "z".repeat(7000), 0.3),
    ];
    const out = resolveLearningsBlock(raw, records);
    expect(out.bounded).toBe(true);
    expect(out.text).toContain("keep: high-value convention");
    expect(out.text).not.toContain("z".repeat(7000));
    expect(out.text).toContain("omitted to fit the 6000-char");
    expect(out.droppedCount).toBe(1);
  });

  it("never truncates an over-budget file when there are no governed records", () => {
    const out = resolveLearningsBlock("y".repeat(9000) + "\n", []);
    expect(out.text).toBe("y".repeat(9000));
    expect(out.bounded).toBe(false);
  });

  it("unbounded: true always passes the raw file through", () => {
    const out = resolveLearningsBlock(
      "w".repeat(9000),
      [rec("2026-07-01T00-00-00-000Z-a", "selected")],
      { unbounded: true }
    );
    expect(out.text).toBe("w".repeat(9000));
    expect(out.bounded).toBe(false);
  });
});

describe("learningsForPrompt", () => {
  it("reads the workspace file + records and honors OTTO_UNBOUNDED_LEARNINGS", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-lfp-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "LEARNINGS.md"),
        "k".repeat(7000),
        "utf8"
      );
      writeMemoryRecord(
        ws,
        rec("2026-07-01T00-00-00-000Z-a", "selected content")
      );
      expect(learningsForPrompt(ws, {}, {}).text).toContain("selected content");
      expect(
        learningsForPrompt(ws, {}, { OTTO_UNBOUNDED_LEARNINGS: "1" }).text
      ).toBe("k".repeat(7000));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when the workspace has no LEARNINGS.md", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-lfp-"));
    try {
      expect(learningsForPrompt(ws, {}, {}).text).toBe(LEARNINGS_FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
