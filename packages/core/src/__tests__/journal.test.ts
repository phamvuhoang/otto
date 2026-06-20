import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJournal, type JournalConfig, type JournalDeps } from "../journal.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-journal-"));
  mkdirSync(join(ws, ".otto", "memory"), { recursive: true });
  writeFileSync(
    join(ws, ".otto", "memory", "m1.json"),
    JSON.stringify({
      id: "m1",
      content: "remember to test first",
      category: "gotcha",
      scope: [],
      confidence: 0.9,
      trust: "trusted",
      status: "active",
      createdAt: "2026-06-01T00:00:00.000Z",
      useCount: 0,
    })
  );
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const cfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  enabled: true,
  autonomous: false,
  categories: ["gotcha"],
  minDaysBetweenPosts: 1,
  ...over,
});

const deps = (over: Partial<JournalDeps> = {}): JournalDeps => ({
  generate: async () =>
    "Writing the failing test first keeps my changes honest and focused on the real requirement.",
  judge: async () => true,
  repoIdentifiers: ["otto"],
  secretPatterns: [],
  now: () => new Date("2026-06-20T00:00:00.000Z"),
  ...over,
});

it("disabled config is a complete no-op", async () => {
  const out = await runJournal(ws, cfg({ enabled: false }), deps());
  expect(out.action).toBe("disabled");
  expect(existsSync(join(ws, ".otto", "journal"))).toBe(false);
});

it("default mode drafts to disk and never publishes", async () => {
  let published = false;
  const out = await runJournal(
    ws,
    cfg(),
    deps({
      publish: async () => {
        published = true;
        return { id: "x" };
      },
    })
  );
  expect(out.action).toBe("drafted");
  expect(published).toBe(false);
  expect(existsSync(join(ws, ".otto", "journal", "drafts", "m1.md"))).toBe(true);
});

it("autonomous mode posts a gate-passing note once and records the ledger", async () => {
  const out = await runJournal(
    ws,
    cfg({ autonomous: true }),
    deps({ publish: async () => ({ id: "post-1" }) })
  );
  expect(out.action).toBe("posted");
  const ledger = JSON.parse(
    readFileSync(join(ws, ".otto", "journal", "posted.json"), "utf8")
  );
  expect(ledger).toHaveLength(1);
  expect(ledger[0].memoryId).toBe("m1");
  expect(ledger[0].postId).toBe("post-1");
});

it("a judge-unsafe verdict denies and never publishes", async () => {
  let published = false;
  const out = await runJournal(
    ws,
    cfg({ autonomous: true }),
    deps({
      judge: async () => false,
      publish: async () => {
        published = true;
        return { id: "x" };
      },
    })
  );
  expect(out.action).toBe("denied");
  expect(published).toBe(false);
});

it("a thrown judge denies, never publishes (fail closed)", async () => {
  let published = false;
  const out = await runJournal(
    ws,
    cfg({ autonomous: true }),
    deps({
      judge: async () => {
        throw new Error("boom");
      },
      publish: async () => {
        published = true;
        return { id: "x" };
      },
    })
  );
  expect(out.action).toBe("denied");
  expect(published).toBe(false);
});

it("a SKIP generation denies (no candidate note)", async () => {
  const out = await runJournal(ws, cfg(), deps({ generate: async () => "SKIP" }));
  expect(out.action).toBe("denied");
});

it("a leaking generated note is denied before any post", async () => {
  let published = false;
  const out = await runJournal(
    ws,
    cfg({ autonomous: true }),
    deps({
      generate: async () => "I fixed it in the otto repo at https://example.com today",
      publish: async () => {
        published = true;
        return { id: "x" };
      },
    })
  );
  expect(out.action).toBe("denied");
  expect(published).toBe(false);
});

it("respects cadence: a recent post skips", async () => {
  mkdirSync(join(ws, ".otto", "journal"), { recursive: true });
  writeFileSync(
    join(ws, ".otto", "journal", "posted.json"),
    JSON.stringify([
      { memoryId: "other", contentHash: "h", postedAt: "2026-06-19T18:00:00.000Z" },
    ])
  );
  const out = await runJournal(ws, cfg({ autonomous: true }), deps());
  expect(out.action).toBe("skipped-cadence");
});

it("returns no-candidate when memory has nothing journal-worthy", async () => {
  rmSync(join(ws, ".otto", "memory", "m1.json"));
  const out = await runJournal(ws, cfg(), deps());
  expect(out.action).toBe("no-candidate");
});
