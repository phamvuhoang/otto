import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addSource,
  applySync,
  auditExternal,
  discoverPackages,
  importedChecksum,
  normalizePackage,
  parseFrontmatter,
  parseSource,
  planSync,
  readLock,
  readSources,
  removeSource,
  writeLock,
  writeSources,
  type ExternalSkillSource,
} from "../external-skills.js";
import { readSkill, skillExists } from "../skills.js";

const NOW = new Date("2026-06-25T00:00:00.000Z");

let work: string;
let srcRoot: string;

/** Write a Superpowers-shaped pack: skills/<name>/SKILL.md with frontmatter. */
function superpowersPack(root: string): void {
  const dir = join(root, "skills", "brainstorming");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: brainstorming\nlicense: MIT\ncapabilities: planning, tdd\n---\nExplore intent before building.\n"
  );
}

/** Write a PM-Skills-shaped pack: a nested skill dir, no license. */
function pmPack(root: string): void {
  const dir = join(root, "product", "roadmap-planning");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: roadmap-planning\n---\nSequence the roadmap.\n"
  );
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "otto-ext-work-"));
  srcRoot = mkdtempSync(join(tmpdir(), "otto-ext-src-"));
  mkdirSync(join(work, ".otto", "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(srcRoot, { recursive: true, force: true });
});

describe("frontmatter", () => {
  it("parses fields and strips the block from the body", () => {
    const { fields, body } = parseFrontmatter(
      "---\nname: x\ndescription: hi\n---\nbody line\n"
    );
    expect(fields).toEqual({ name: "x", description: "hi" });
    expect(body).toBe("body line\n");
  });

  it("returns the whole text as body when there is no frontmatter", () => {
    const { fields, body } = parseFrontmatter("just text");
    expect(fields).toEqual({});
    expect(body).toBe("just text");
  });
});

describe("sources read/write", () => {
  it("absent sources.json reads as []", () => {
    expect(readSources(work)).toEqual([]);
  });

  it("malformed sources.json reads as [] (never throws)", () => {
    writeFileSync(join(work, ".otto", "skills", "sources.json"), "{ not json");
    expect(readSources(work)).toEqual([]);
  });

  it("round-trips and sorts by name", () => {
    writeSources(work, [
      { name: "zeta", type: "local", location: "/z" },
      { name: "alpha", type: "git", location: "https://x", ref: "v1" },
    ]);
    const got = readSources(work);
    expect(got.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(got[0].ref).toBe("v1");
  });

  it("parseSource defaults type to local and drops invalid", () => {
    expect(parseSource({ name: "a", location: "/p" })?.type).toBe("local");
    expect(parseSource({ name: "a" })).toBeNull();
    expect(parseSource({ location: "/p" })).toBeNull();
  });

  it("add replaces by name; remove drops by name", () => {
    let s: ExternalSkillSource[] = [];
    s = addSource(s, { name: "a", type: "local", location: "/1" });
    s = addSource(s, { name: "a", type: "local", location: "/2" });
    expect(s).toHaveLength(1);
    expect(s[0].location).toBe("/2");
    s = removeSource(s, "a");
    expect(s).toEqual([]);
  });
});

describe("fresh-workspace writes create missing dirs", () => {
  it("writeSources creates .otto/skills on a workspace with no .otto", () => {
    const fresh = mkdtempSync(join(tmpdir(), "otto-ext-fresh-"));
    writeSources(fresh, [{ name: "a", type: "local", location: "/p" }]);
    expect(readSources(fresh).map((s) => s.name)).toEqual(["a"]);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("writeLock creates .otto on a workspace with no .otto", () => {
    const fresh = mkdtempSync(join(tmpdir(), "otto-ext-fresh-"));
    writeLock(fresh, { entries: [] });
    expect(readLock(fresh)).toEqual({ entries: [] });
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("lock read/write", () => {
  it("absent lock reads as empty (never throws)", () => {
    expect(readLock(work)).toEqual({ entries: [] });
  });

  it("round-trips entries sorted by skill", () => {
    writeLock(work, {
      entries: [
        {
          skill: "z",
          source: "s",
          type: "local",
          upstreamPath: "z",
          checksum: "1",
          importedAt: "t",
          capabilities: [],
        },
        {
          skill: "a",
          source: "s",
          type: "local",
          upstreamPath: "a",
          checksum: "2",
          importedAt: "t",
          capabilities: [],
        },
      ],
    });
    expect(readLock(work).entries.map((e) => e.skill)).toEqual(["a", "z"]);
  });
});

describe("discovery + normalization", () => {
  it("discovers SKILL.md packages by frontmatter name, nested and sorted", () => {
    superpowersPack(srcRoot);
    pmPack(srcRoot);
    const pkgs = discoverPackages(srcRoot);
    expect(pkgs.map((p) => p.name)).toEqual([
      "brainstorming",
      "roadmap-planning",
    ]);
    expect(pkgs[0].upstreamPath).toBe("skills/brainstorming");
  });

  it("absent source dir discovers nothing", () => {
    expect(discoverPackages(join(srcRoot, "nope"))).toEqual([]);
  });

  it("normalizes to an inert unverified skill with provenance", () => {
    superpowersPack(srcRoot);
    const [pkg] = discoverPackages(srcRoot);
    const src: ExternalSkillSource = {
      name: "sp",
      type: "git",
      location: "u",
      ref: "v2",
    };
    const { skill, entry } = normalizePackage(src, pkg, NOW);
    expect(skill.trust).toBe("unverified");
    expect(skill.validation).toEqual({});
    expect(skill.capabilities).toEqual(["planning", "tdd"]);
    expect(skill.instructions).toBe("Explore intent before building.\n");
    expect(skill.provenance).toMatchObject({
      source: "sp",
      upstreamPath: "skills/brainstorming",
      upstreamRef: "v2",
      license: "MIT",
    });
    expect(entry.checksum).toBe(skill.provenance!.checksum);
  });
});

describe("planSync + applySync", () => {
  function localSource(): ExternalSkillSource {
    return { name: "fixtures", type: "local", location: srcRoot };
  }

  it("dry-run plan is read-only and deterministic", () => {
    superpowersPack(srcRoot);
    pmPack(srcRoot);
    const a = planSync(work, [localSource()], NOW);
    const b = planSync(work, [localSource()], NOW);
    expect(a).toEqual(b);
    expect(a.items.map((i) => [i.skill, i.action])).toEqual([
      ["brainstorming", "add"],
      ["roadmap-planning", "add"],
    ]);
    // nothing written
    expect(skillExists(work, "brainstorming")).toBe(false);
    expect(readLock(work).entries).toEqual([]);
  });

  it("apply writes inert packages and the lock; re-plan is unchanged", () => {
    superpowersPack(srcRoot);
    applySync(work, planSync(work, [localSource()], NOW));
    expect(skillExists(work, "brainstorming")).toBe(true);
    expect(readSkill(work, "brainstorming")?.trust).toBe("unverified");
    expect(readLock(work).entries.map((e) => e.skill)).toEqual([
      "brainstorming",
    ]);

    const replan = planSync(work, [localSource()], NOW);
    expect(replan.items.map((i) => i.action)).toEqual(["unchanged"]);
  });

  it("flags a conflict when two sources claim the same skill name", () => {
    superpowersPack(srcRoot);
    const dup = mkdtempSync(join(tmpdir(), "otto-ext-dup-"));
    superpowersPack(dup);
    const plan = planSync(
      work,
      [
        { name: "a-first", type: "local", location: srcRoot },
        { name: "b-second", type: "local", location: dup },
      ],
      NOW
    );
    const actions = plan.items.map((i) => [i.source, i.action]);
    expect(actions).toContainEqual(["a-first", "add"]);
    expect(actions).toContainEqual(["b-second", "conflict"]);
    rmSync(dup, { recursive: true, force: true });
  });
});

describe("auditExternal", () => {
  it("flags unpinned refs, missing license, duplicate names, and unsupported types", () => {
    const sources: ExternalSkillSource[] = [
      { name: "g", type: "git", location: "u" }, // unpinned
      { name: "r", type: "registry", location: "u" }, // unsupported
    ];
    const lock = {
      entries: [
        {
          skill: "dup",
          source: "s1",
          type: "local" as const,
          upstreamPath: "a",
          checksum: "1",
          importedAt: "t",
          capabilities: [],
        },
        {
          skill: "dup",
          source: "s2",
          type: "local" as const,
          upstreamPath: "b",
          checksum: "1",
          importedAt: "t",
          capabilities: [],
        },
      ],
    };
    const kinds = auditExternal(sources, lock, () => null).map((f) => f.kind);
    expect(kinds).toContain("unpinned-ref");
    expect(kinds).toContain("unsupported-format");
    expect(kinds).toContain("duplicate-name");
    expect(kinds).toContain("missing-license");
  });

  it("flags a stale copy when the on-disk body drifts from the lock", () => {
    superpowersPack(srcRoot);
    applySync(
      work,
      planSync(
        work,
        [{ name: "fixtures", type: "local", location: srcRoot }],
        NOW
      )
    );
    const lock = readLock(work);
    expect(importedChecksum(work, "brainstorming")).toBe(
      lock.entries[0].checksum
    );

    writeFileSync(
      join(work, ".otto", "skills", "brainstorming", "instructions.md"),
      "tampered\n"
    );
    const findings = auditExternal([], lock, (s) => importedChecksum(work, s));
    expect(
      findings.some(
        (f) => f.kind === "stale-copy" && f.subject === "brainstorming"
      )
    ).toBe(true);
  });
});
