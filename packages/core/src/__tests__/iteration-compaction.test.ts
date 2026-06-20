import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMITS_BUDGET_CHARS,
  compactCommits,
  formatCompactedCommits,
  parseCommitLog,
} from "../iteration-compaction.js";

// A realistic `git log -n N --format="%H%n%ad%n%B---" --date=short` payload:
// hash line, date line, full body (subject + bullets), then a `---` separator,
// newest commit first.
const RAW = [
  "aaaaaaa",
  "2026-06-20",
  "feat: newest",
  "",
  "- bullet one",
  "- bullet two",
  "---",
  "bbbbbbb",
  "2026-06-19",
  "fix: middle",
  "",
  "- detail",
  "---",
  "ccccccc",
  "2026-06-18",
  "chore: oldest",
  "---",
  "",
].join("\n");

describe("parseCommitLog", () => {
  it("parses git-log-format output into hash/date/subject/body entries", () => {
    const entries = parseCommitLog(RAW);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      hash: "aaaaaaa",
      date: "2026-06-20",
      subject: "feat: newest",
      body: "feat: newest\n\n- bullet one\n- bullet two",
    });
    expect(entries[2]).toEqual({
      hash: "ccccccc",
      date: "2026-06-18",
      subject: "chore: oldest",
      body: "chore: oldest",
    });
  });

  it("returns [] for the `No commits found` fallback and for empty input", () => {
    expect(parseCommitLog("No commits found")).toEqual([]);
    expect(parseCommitLog("")).toEqual([]);
    expect(parseCommitLog("   \n  \n")).toEqual([]);
  });

  it("skips a chunk whose first line is not a commit hash but keeps valid ones", () => {
    // The non-hash chunk has ≥3 non-empty lines, so it clears the `<3` guard and
    // is rejected by the hash check (line 75), not the length guard.
    const raw = [
      "not-a-hash",
      "2026-06-20",
      "garbage body line",
      "---",
      "aaaaaaa",
      "2026-06-20",
      "feat: real",
      "---",
      "",
    ].join("\n");
    const entries = parseCommitLog(raw);
    expect(entries).toEqual([
      {
        hash: "aaaaaaa",
        date: "2026-06-20",
        subject: "feat: real",
        body: "feat: real",
      },
    ]);
  });
});

describe("compactCommits", () => {
  it("keeps everything full when it fits under the budget", () => {
    const entries = parseCommitLog(RAW);
    const c = compactCommits(entries, { maxChars: 100_000 });
    expect(c.kept).toEqual(entries);
    expect(c.compacted).toEqual([]);
    expect(c.savedChars).toBe(0);
  });

  it("keeps the newest full and summarizes older commits past the budget", () => {
    const entries = parseCommitLog(RAW);
    // Budget that fits exactly the newest commit's full body, nothing more.
    const full0 = `${entries[0].hash}\n${entries[0].date}\n${entries[0].body}`;
    const c = compactCommits(entries, { maxChars: full0.length });
    expect(c.kept).toEqual([entries[0]]);
    expect(c.compacted).toEqual([entries[1], entries[2]]);
    expect(c.savedChars).toBeGreaterThan(0);
    // savedChars = the body chars dropped by degrading to subject-only.
    expect(c.keptChars).toBe(full0.length);
  });

  it("uses the default budget when maxChars is omitted", () => {
    const c = compactCommits(parseCommitLog(RAW));
    expect(DEFAULT_COMMITS_BUDGET_CHARS).toBeGreaterThan(0);
    expect(c.budgetChars).toBe(DEFAULT_COMMITS_BUDGET_CHARS);
  });

  it("returns an empty bound for no commits", () => {
    const c = compactCommits([]);
    expect(c.kept).toEqual([]);
    expect(c.compacted).toEqual([]);
    expect(c.savedChars).toBe(0);
  });
});

describe("formatCompactedCommits", () => {
  it("renders full bodies and adds no note when nothing was compacted", () => {
    const out = formatCompactedCommits(
      compactCommits(parseCommitLog(RAW), { maxChars: 100_000 })
    );
    expect(out).toContain("- bullet one");
    expect(out).toContain("- detail");
    expect(out).not.toContain("_Compacted:");
  });

  it("drops older bodies to their subject and appends a what-was-compacted note", () => {
    const entries = parseCommitLog(RAW);
    const full0 = `${entries[0].hash}\n${entries[0].date}\n${entries[0].body}`;
    const out = formatCompactedCommits(
      compactCommits(entries, { maxChars: full0.length })
    );
    // Newest kept in full…
    expect(out).toContain("- bullet one");
    // …older summarized to subject-only (body bullets gone, subject kept).
    expect(out).not.toContain("- detail");
    expect(out).toContain("fix: middle");
    expect(out).toContain("chore: oldest");
    expect(out).toMatch(/_Compacted: 2 older commit\(s\)/);
    // Newest-first order preserved.
    expect(out.indexOf("feat: newest")).toBeLessThan(out.indexOf("fix: middle"));
  });
});
