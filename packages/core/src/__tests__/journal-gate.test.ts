import { describe, expect, it } from "vitest";
import {
  screenGate1,
  screenGate2,
  screenEntry,
  MAX_ENTRY_CHARS,
  type GateContext,
} from "../journal-gate.js";

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  repoIdentifiers: ["otto", "phamvuhoang"],
  secretPatterns: [],
  forbiddenTerms: [],
  ...over,
});

const ok = (s: string) => expect(screenGate1(s, ctx())).toEqual({ ok: true });
const deny = (s: string, c = ctx()) => {
  const r = screenGate1(s, c);
  expect(r.ok).toBe(false);
  return r;
};

describe("screenGate1 — deny-list", () => {
  it("passes a clean generic craft note", () => {
    ok(
      "Today I learned to write the failing test before the fix — it kept my changes honest."
    );
  });
  it("denies token/secret shapes", () => {
    deny("My key is sk-abcd1234abcd1234abcd1234.");
    deny("export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    deny("password=hunter2 in the config");
    deny("-----BEGIN RSA PRIVATE KEY-----");
    deny("Authorization: Bearer abcdef.ghijkl.mnopqr");
  });
  it("denies URLs, paths, and code fences/spans", () => {
    deny("see https://example.com/secret");
    deny("the bug was in /Users/me/proj/src/loop.ts");
    deny("relative path ./packages/core/src/x.ts broke");
    deny("```ts\nconst x = 1;\n```");
    deny("inline `runLoop()` call");
  });
  it("denies the repo's own identifiers (case-insensitive, word-ish)", () => {
    deny("I was working in the Otto harness today.");
    deny("phamvuhoang/otto had a flaky test.");
  });
  it("denies policy secretPatterns and survives a malformed pattern", () => {
    deny("acme-internal build broke", ctx({ secretPatterns: ["acme-internal"] }));
    const r = screenGate1("totally fine text", ctx({ secretPatterns: ["("] }));
    expect(r.ok).toBe(false);
  });
});

describe("screenGate2 — generalization", () => {
  it("passes generic craft prose", () => {
    expect(
      screenGate2(
        "Writing the test first kept me honest about the real requirement.",
        ctx()
      ).ok
    ).toBe(true);
  });
  it("denies task-key shapes", () => {
    expect(screenGate2("fixed issue-42 today, that was rough", ctx()).ok).toBe(false);
    expect(screenGate2("the ticket ENG-1234 was tricky to reproduce", ctx()).ok).toBe(
      false
    );
  });
  it("denies forbidden source terms (scope/taskKey/run)", () => {
    expect(
      screenGate2(
        "the parser module was the real cause of the slowdown here",
        ctx({ forbiddenTerms: ["parser"] })
      ).ok
    ).toBe(false);
  });
  it("denies an over-length or too-short note", () => {
    expect(screenGate2("x".repeat(MAX_ENTRY_CHARS + 1), ctx()).ok).toBe(false);
    expect(screenGate2("too short", ctx()).ok).toBe(false);
  });
});

describe("screenEntry — orchestrator (default-deny)", () => {
  const clean =
    "Writing the failing test before the change kept my work honest and focused.";
  it("passes a clean note through gates 1+2 with no judge", async () => {
    expect((await screenEntry(clean, ctx())).ok).toBe(true);
  });
  it("denies when the judge says unsafe", async () => {
    const r = await screenEntry(clean, ctx(), async () => false);
    expect(r).toMatchObject({ ok: false, gate: 3 });
  });
  it("denies when the judge throws (fail closed)", async () => {
    const r = await screenEntry(clean, ctx(), async () => {
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
  });
  it("short-circuits at gate 1 before calling the judge", async () => {
    let called = false;
    const r = await screenEntry("leak https://x.com here now", ctx(), async () => {
      called = true;
      return true;
    });
    expect(r).toMatchObject({ ok: false, gate: 1 });
    expect(called).toBe(false);
  });
});
