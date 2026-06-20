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
  findSkillCandidates,
  globMatch,
  listSkillIds,
  parseSkill,
  readSkill,
  readSkills,
  recordValidation,
  selectSkills,
  skillDir,
  skillExists,
  skillStatus,
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

describe("skillStatus / recordValidation", () => {
  const validatedAt = "2026-06-01T00:00:00.000Z";

  it("is unvalidated when no run has validated it", () => {
    expect(skillStatus(skill({ validation: {} }))).toBe("unvalidated");
  });

  it("is validated when proven and within (or without) a freshness window", () => {
    const s = skill({ validation: { lastValidatedRun: "run-1", lastValidatedAt: validatedAt } });
    // No revalidate window → always validated once proven.
    expect(skillStatus(s, new Date("2027-01-01T00:00:00.000Z"))).toBe("validated");
    // Within the window → validated.
    const windowed = skill({
      revalidateAfterDays: 30,
      validation: { lastValidatedRun: "run-1", lastValidatedAt: validatedAt },
    });
    expect(skillStatus(windowed, new Date("2026-06-15T00:00:00.000Z"))).toBe("validated");
  });

  it("goes stale once revalidateAfterDays elapse since validation", () => {
    const s = skill({
      revalidateAfterDays: 7,
      validation: { lastValidatedRun: "run-1", lastValidatedAt: validatedAt },
    });
    expect(skillStatus(s, new Date("2026-06-20T00:00:00.000Z"))).toBe("stale");
  });

  it("ignores an unparseable validation timestamp rather than staling it", () => {
    const s = skill({
      revalidateAfterDays: 7,
      validation: { lastValidatedRun: "run-1", lastValidatedAt: "not-a-date" },
    });
    expect(skillStatus(s, new Date("2027-01-01T00:00:00.000Z"))).toBe("validated");
  });

  it("recordValidation stamps the run + time without mutating the input", () => {
    const s = skill({ validation: {} });
    const v = recordValidation(s, "run-9", new Date("2026-06-19T00:00:00.000Z"));
    expect(v.validation).toEqual({ lastValidatedRun: "run-9", lastValidatedAt: "2026-06-19T00:00:00.000Z" });
    expect(s.validation).toEqual({}); // input untouched
    expect(skillStatus(v)).toBe("validated");
  });
});

describe("globMatch", () => {
  it("matches ** across separators and * within a segment", () => {
    expect(globMatch("packages/core/**", "packages/core/src/eval.ts")).toBe(true);
    expect(globMatch("packages/*/src/*.ts", "packages/core/src/eval.ts")).toBe(true);
    expect(globMatch("packages/core/src/*.ts", "packages/core/src/eval.ts")).toBe(true);
    // single * does not span separators, and an unrelated prefix does not match.
    expect(globMatch("packages/*.ts", "packages/core/src/eval.ts")).toBe(false);
    expect(globMatch("docs/**", "packages/core/src/eval.ts")).toBe(false);
  });
});

describe("selectSkills", () => {
  const validated = (over: Partial<Skill> = {}) =>
    skill({ validation: { lastValidatedRun: "run-1" }, ...over });

  it("only marks validated skills eligible, with a reason for the rest", () => {
    const matches = selectSkills([
      validated({ name: "ready" }),
      skill({ name: "never-validated", validation: {} }),
    ]);
    const byName = Object.fromEntries(matches.map((m) => [m.name, m]));
    expect(byName["ready"].eligible).toBe(true);
    expect(byName["never-validated"].eligible).toBe(false);
    expect(byName["never-validated"].reasons.join(" ")).toMatch(/validation required/);
  });

  it("scores capability and scope matches, explaining each", () => {
    const m = selectSkills(
      [validated({ name: "s", capabilities: ["release"], scope: ["packages/core/**"] })],
      { capability: "release", changedPaths: ["packages/core/src/eval.ts"] }
    )[0];
    expect(m.score).toBe(4); // +2 capability, +2 scope
    expect(m.reasons.join(" ")).toMatch(/declares capability "release"/);
    expect(m.reasons.join(" ")).toMatch(/scope matches changed file/);
  });

  it("excludes a skill whose constraint forbids the change's risk class", () => {
    const m = selectSkills(
      [validated({ name: "s", constraints: ["not for security-sensitive changes"] })],
      { changedPaths: ["packages/core/src/auth.ts"] } // classifyRisk → security-sensitive
    )[0];
    expect(m.eligible).toBe(false);
    expect(m.reasons.join(" ")).toMatch(/constraint for risk class "security-sensitive"/);
  });

  it("ranks eligible-first, then score, then name (deterministic)", () => {
    const order = selectSkills(
      [
        skill({ name: "z-unvalidated", validation: {} }),
        validated({ name: "low", capabilities: [] }),
        validated({ name: "high", capabilities: ["release"] }),
      ],
      { capability: "release" }
    ).map((m) => m.name);
    expect(order).toEqual(["high", "low", "z-unvalidated"]);
  });
});

describe("findSkillCandidates", () => {
  const run = (over: Partial<import("../skills.js").CandidateRun> = {}) => ({
    runId: "r",
    bin: "otto-afk",
    mode: "afk",
    inputs: "plan.md",
    exitReason: "complete",
    ...over,
  });

  it("surfaces a signature seen >= 2 times among successful runs", () => {
    const cands = findSkillCandidates([
      run({ runId: "a1", inputs: "release.md" }),
      run({ runId: "a2", inputs: "release.md" }),
      run({ runId: "b1", inputs: "one-off.md" }), // single → not a candidate
    ]);
    expect(cands).toHaveLength(1);
    expect(cands[0].inputs).toBe("release.md");
    expect(cands[0].runIds).toEqual(["a1", "a2"]);
    expect(cands[0].count).toBe(2);
    expect(cands[0].suggestedName).toBe("afk-release-md");
  });

  it("ignores unsuccessful runs", () => {
    const cands = findSkillCandidates([
      run({ runId: "a1", inputs: "x.md", exitReason: "complete" }),
      run({ runId: "a2", inputs: "x.md", exitReason: "stopped (budget)" }),
    ]);
    expect(cands).toEqual([]);
  });

  it("groups by bin+mode+inputs and sorts by count desc", () => {
    const cands = findSkillCandidates([
      run({ runId: "g1", mode: "ghafk", bin: "otto-ghafk", inputs: "42" }),
      run({ runId: "g2", mode: "ghafk", bin: "otto-ghafk", inputs: "42" }),
      run({ runId: "p1", inputs: "p.md" }),
      run({ runId: "p2", inputs: "p.md" }),
      run({ runId: "p3", inputs: "p.md" }),
    ]);
    expect(cands.map((c) => [c.inputs, c.count])).toEqual([
      ["p.md", 3],
      ["42", 2],
    ]);
  });
});
