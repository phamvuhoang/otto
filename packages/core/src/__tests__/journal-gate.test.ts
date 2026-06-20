import { describe, expect, it } from "vitest";
import { screenGate1, type GateContext } from "../journal-gate.js";

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
