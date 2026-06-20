import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournalConfig } from "../journal-config.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-jcfg-"));
  mkdirSync(join(ws, ".otto"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const write = (o: unknown) =>
  writeFileSync(join(ws, ".otto", "config.json"), JSON.stringify(o));

describe("readJournalConfig", () => {
  it("returns null when there is no config file", () => {
    expect(readJournalConfig(ws, {})).toBeNull();
  });
  it("returns null when there is no journal block", () => {
    write({ branchStrategy: "branch" });
    expect(readJournalConfig(ws, {})).toBeNull();
  });
  it("returns null when enabled is false", () => {
    write({ journal: { enabled: false } });
    expect(readJournalConfig(ws, {})).toBeNull();
  });
  it("applies defaults when enabled", () => {
    write({ journal: { enabled: true } });
    expect(readJournalConfig(ws, {})).toMatchObject({
      enabled: true,
      autonomous: false,
      categories: ["gotcha", "dead-end"],
      minDaysBetweenPosts: 1,
    });
  });
  it("requires BOTH config.autonomous and the env flag to be autonomous", () => {
    write({ journal: { enabled: true, autonomous: true } });
    expect(readJournalConfig(ws, {})?.autonomous).toBe(false);
    expect(
      readJournalConfig(ws, { OTTO_JOURNAL_AUTONOMOUS: "1" })?.autonomous
    ).toBe(true);
  });
  it("honors a custom category list and cadence", () => {
    write({
      journal: { enabled: true, categories: ["decision"], minDaysBetweenPosts: 3 },
    });
    expect(readJournalConfig(ws, {})).toMatchObject({
      categories: ["decision"],
      minDaysBetweenPosts: 3,
    });
  });
});
