import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  parseSafetyPolicy,
  readSafetyPolicy,
  type SafetyPolicy,
} from "../safety-policy.js";

describe("DEFAULT_POLICY", () => {
  it("is permissive — every rule list is empty (no restriction)", () => {
    expect(DEFAULT_POLICY).toEqual({
      allowedWriteRoots: [],
      blockedCommands: [],
      allowedNetworkDomains: [],
      secretPatterns: [],
      highRiskGlobs: [],
      approvalRequiredActions: [],
    });
  });

  it("carries exactly the six issue-scoped rule fields", () => {
    expect(Object.keys(DEFAULT_POLICY).sort()).toEqual(
      [
        "allowedNetworkDomains",
        "allowedWriteRoots",
        "approvalRequiredActions",
        "blockedCommands",
        "highRiskGlobs",
        "secretPatterns",
      ].sort()
    );
  });
});

describe("parseSafetyPolicy", () => {
  it("round-trips a fully-populated valid object", () => {
    const full: SafetyPolicy = {
      allowedWriteRoots: ["src", "docs"],
      blockedCommands: ["rm -rf /", "curl"],
      allowedNetworkDomains: ["github.com"],
      secretPatterns: ["AKIA[0-9A-Z]{16}"],
      highRiskGlobs: ["**/*.env", ".github/workflows/**"],
      approvalRequiredActions: ["force-push"],
    };
    expect(parseSafetyPolicy(full)).toEqual(full);
  });

  it("fills defaults for missing fields", () => {
    expect(parseSafetyPolicy({ blockedCommands: ["curl"] })).toEqual({
      ...DEFAULT_POLICY,
      blockedCommands: ["curl"],
    });
  });

  it("replaces a non-array field with its default", () => {
    expect(
      parseSafetyPolicy({ blockedCommands: "curl" }).blockedCommands
    ).toEqual([]);
  });

  it("filters non-string array elements", () => {
    expect(
      parseSafetyPolicy({ blockedCommands: ["curl", 5, null, "wget"] })
        .blockedCommands
    ).toEqual(["curl", "wget"]);
  });

  it.each([null, undefined, 42, "policy", ["a"]])(
    "returns DEFAULT_POLICY for a non-object input (%s)",
    (raw) => {
      expect(parseSafetyPolicy(raw)).toEqual(DEFAULT_POLICY);
    }
  );

  it("returns a fresh object, not the shared DEFAULT_POLICY reference", () => {
    const p = parseSafetyPolicy({});
    expect(p).toEqual(DEFAULT_POLICY);
    expect(p).not.toBe(DEFAULT_POLICY);
    expect(p.blockedCommands).not.toBe(DEFAULT_POLICY.blockedCommands);
  });
});

describe("readSafetyPolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otto-policy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns DEFAULT_POLICY when .otto/policy.json is absent", () => {
    expect(readSafetyPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("returns DEFAULT_POLICY when the file is malformed JSON", () => {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "policy.json"), "{ not json");
    expect(readSafetyPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("parses a valid .otto/policy.json", () => {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(
      join(dir, ".otto", "policy.json"),
      JSON.stringify({ blockedCommands: ["curl"], allowedWriteRoots: ["src"] })
    );
    expect(readSafetyPolicy(dir)).toEqual({
      ...DEFAULT_POLICY,
      blockedCommands: ["curl"],
      allowedWriteRoots: ["src"],
    });
  });
});
