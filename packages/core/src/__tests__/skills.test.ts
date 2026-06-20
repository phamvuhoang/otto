import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  listSkillIds,
  parseSkill,
  readSkill,
  readSkills,
  skillDir,
  skillExists,
  toSkillName,
  writeSkill,
  type Skill,
} from "../skills.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-skills-"));
}

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "release-flow",
    version: "1.0.0",
    capabilities: ["release"],
    constraints: [],
    scope: ["packages/core/**"],
    instructions: "Run the release steps.",
    scripts: {},
    tests: [],
    validation: {},
    trust: "unverified",
    createdAt: "2026-06-19T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

describe("toSkillName", () => {
  it("normalizes free text to a filesystem-safe name", () => {
    expect(toSkillName("Release Flow!")).toBe("release-flow");
    expect(toSkillName("  test/bootstrap  ")).toBe("test-bootstrap");
    expect(toSkillName("a".repeat(80)).length).toBe(48);
  });
});

describe("parseSkill", () => {
  it("round-trips a full valid object", () => {
    const s = parseSkill({
      name: "release-flow",
      version: "2.1.0",
      capabilities: ["release", "tag"],
      constraints: ["not security-sensitive"],
      scope: ["packages/**"],
      instructions: "inline body",
      scripts: { build: "pnpm -r build" },
      tests: ["pnpm test"],
      validation: { lastValidatedRun: "run-1", lastValidatedAt: "2026-06-19T00:00:00.000Z" },
      trust: "trusted",
      createdAt: "2026-06-19T00:00:00.000Z",
      useCount: 3,
      revalidateAfterDays: 30,
    });
    expect(s?.name).toBe("release-flow");
    expect(s?.capabilities).toEqual(["release", "tag"]);
    expect(s?.scripts).toEqual({ build: "pnpm -r build" });
    expect(s?.validation.lastValidatedRun).toBe("run-1");
    expect(s?.trust).toBe("trusted");
    expect(s?.revalidateAfterDays).toBe(30);
  });

  it("returns null for a non-object or a missing name", () => {
    expect(parseSkill(null)).toBeNull();
    expect(parseSkill([])).toBeNull();
    expect(parseSkill({ version: "1.0.0" })).toBeNull();
  });

  it("fills safe defaults for missing/invalid fields", () => {
    const s = parseSkill({ name: "x", capabilities: "nope", trust: "bogus", scripts: ["nope"] });
    expect(s?.version).toBe("0.0.0");
    expect(s?.capabilities).toEqual([]);
    expect(s?.scripts).toEqual({});
    expect(s?.trust).toBe("unverified");
    expect(s?.useCount).toBe(0);
    expect(s?.validation).toEqual({});
  });

  it("filters non-string array elements", () => {
    const s = parseSkill({ name: "x", capabilities: ["a", 1, "b"], tests: [true, "pnpm test"] });
    expect(s?.capabilities).toEqual(["a", "b"]);
    expect(s?.tests).toEqual(["pnpm test"]);
  });
});

describe("writeSkill / readSkill", () => {
  it("round-trips a package, with instructions.md as the body source of truth", () => {
    const ws = tmp();
    writeSkill(ws, skill({ instructions: "## Release\nDo the thing." }));
    const read = readSkill(ws, "release-flow");
    expect(read?.name).toBe("release-flow");
    expect(read?.instructions).toBe("## Release\nDo the thing.");
    expect(read?.scope).toEqual(["packages/core/**"]);
    rmSync(ws, { recursive: true, force: true });
  });

  it("instructions.md overrides any inline instructions in skill.json", () => {
    const ws = tmp();
    const dir = skillDir(ws, "s");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ name: "s", instructions: "inline" }));
    writeFileSync(join(dir, "instructions.md"), "from the sidecar");
    expect(readSkill(ws, "s")?.instructions).toBe("from the sidecar");
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns null for an absent or malformed skill", () => {
    const ws = tmp();
    expect(readSkill(ws, "ghost")).toBeNull();
    const dir = skillDir(ws, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), "{ not json");
    expect(readSkill(ws, "broken")).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("listSkillIds / readSkills / skillExists", () => {
  it("lists package dirs sorted and reads them, skipping malformed", () => {
    const ws = tmp();
    writeSkill(ws, skill({ name: "b-skill" }));
    writeSkill(ws, skill({ name: "a-skill" }));
    // A malformed package directory is listed but skipped on read.
    const broken = skillDir(ws, "c-broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "skill.json"), "nope");

    expect(listSkillIds(ws)).toEqual(["a-skill", "b-skill", "c-broken"]);
    expect(readSkills(ws).map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(skillExists(ws, "a-skill")).toBe(true);
    // skillExists is a plain file check: the broken package's skill.json exists
    // (it just doesn't parse), while a never-created name does not.
    expect(skillExists(ws, "c-broken")).toBe(true);
    expect(skillExists(ws, "ghost")).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  it("absent skills dir → [] (never throws)", () => {
    expect(listSkillIds(tmp())).toEqual([]);
    expect(readSkills(tmp())).toEqual([]);
  });
});
