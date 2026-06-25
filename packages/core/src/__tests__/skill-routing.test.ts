import { describe, expect, it } from "vitest";

import { recordStaticValidation, type Skill } from "../skills.js";
import { skillChecksum } from "../skill-validation.js";
import {
  DEFAULT_SKILLS_BUDGET_CHARS,
  formatSkillInjection,
  routeSkillsForStage,
  stageFamily,
  toSkillUsages,
} from "../skill-routing.js";

/** A skill statically validated to `compatibility` for `stages`, body in sync. */
function validated(
  over: Partial<Skill>,
  compatibility: "afk-safe" | "stage-scoped" | "interactive-only" | "blocked",
  stages: string[] = []
): Skill {
  const base: Skill = {
    name: "s",
    version: "1.0.0",
    capabilities: [],
    constraints: [],
    scope: [],
    instructions: "Do the thing.",
    scripts: {},
    tests: [],
    validation: {},
    trust: "unverified",
    createdAt: new Date(0).toISOString(),
    useCount: 0,
    ...over,
  };
  return recordStaticValidation(base, {
    compatibility,
    stages,
    checksum: skillChecksum(base.instructions),
  });
}

describe("stageFamily", () => {
  it("maps concrete stage names to families", () => {
    expect(stageFamily("plan")).toBe("plan");
    expect(stageFamily("implementer")).toBe("implement");
    expect(stageFamily("ghafk-implementer")).toBe("implement");
    expect(stageFamily("apply-review-implementer")).toBe("implement");
    expect(stageFamily("verifier")).toBe("implement");
    expect(stageFamily("reviewer")).toBe("review");
    expect(stageFamily("report-rewrite")).toBe("report");
    expect(stageFamily("journal-write")).toBe("journal");
  });

  it("returns null for an unknown stage", () => {
    expect(stageFamily("mystery")).toBeNull();
  });
});

describe("routeSkillsForStage eligibility", () => {
  it("selects an afk-safe skill on any stage", () => {
    const r = routeSkillsForStage([validated({ name: "any" }, "afk-safe")], {
      stageName: "plan",
    });
    expect(r.selected.map((s) => s.skill.name)).toContain("any");
  });

  it("selects a stage-scoped skill only on its stage", () => {
    const sk = validated({ name: "rev" }, "stage-scoped", ["review"]);
    expect(
      routeSkillsForStage([sk], { stageName: "reviewer" }).selected.length
    ).toBe(1);
    expect(
      routeSkillsForStage([sk], { stageName: "plan" }).selected.length
    ).toBe(0);
  });

  it("never selects a blocked skill", () => {
    const r = routeSkillsForStage([validated({ name: "bad" }, "blocked")], {
      stageName: "plan",
    });
    expect(r.selected.length).toBe(0);
    expect(r.verdicts.find((v) => v.name === "bad")?.eligible).toBe(false);
  });

  it("never selects an interactive-only skill (AFK is non-interactive)", () => {
    const r = routeSkillsForStage(
      [validated({ name: "ix" }, "interactive-only")],
      { stageName: "plan" }
    );
    expect(r.selected.length).toBe(0);
  });

  it("never selects an unvalidated skill (no compatibility recorded)", () => {
    const raw: Skill = {
      ...validated({ name: "raw" }, "afk-safe"),
      validation: {},
    };
    expect(
      routeSkillsForStage([raw], { stageName: "plan" }).selected.length
    ).toBe(0);
  });

  it("excludes a skill whose body drifted since validation (needs revalidation)", () => {
    const drifted: Skill = {
      ...validated({ name: "drift", instructions: "old" }, "afk-safe"),
      instructions: "a different body now",
    };
    const r = routeSkillsForStage([drifted], { stageName: "plan" });
    expect(r.selected.length).toBe(0);
    expect(
      r.verdicts.find((v) => v.name === "drift")?.reasons.join(" ")
    ).toMatch(/revalidat/i);
  });
});

describe("routeSkillsForStage scoring + budget", () => {
  it("ranks a scope-matching skill above a repo-wide one", () => {
    const scoped = validated(
      { name: "scoped", scope: ["packages/core/**"] },
      "afk-safe"
    );
    const wide = validated({ name: "wide" }, "afk-safe");
    const r = routeSkillsForStage([wide, scoped], {
      stageName: "implementer",
      changedPaths: ["packages/core/src/x.ts"],
    });
    expect(r.selected[0].skill.name).toBe("scoped");
  });

  it("enforces the char budget — drops lower-ranked skills that do not fit", () => {
    const big = "x".repeat(DEFAULT_SKILLS_BUDGET_CHARS);
    const a = validated({ name: "a", instructions: big }, "afk-safe");
    const b = validated({ name: "b", instructions: big }, "afk-safe");
    // Per-skill cap = full budget, so the first selection alone fills it.
    const r = routeSkillsForStage([a, b], {
      stageName: "plan",
      perSkillChars: DEFAULT_SKILLS_BUDGET_CHARS,
    });
    expect(r.selected.length).toBe(1);
    expect(r.usedChars).toBeLessThanOrEqual(r.budgetChars);
    expect(r.verdicts.find((v) => !v.selected)?.reasons.join(" ")).toMatch(
      /budget/i
    );
  });

  it("bounds each selected skill's excerpt (never the full library)", () => {
    const huge = "line\n".repeat(5000);
    const r = routeSkillsForStage(
      [validated({ name: "huge", instructions: huge }, "afk-safe")],
      { stageName: "plan" }
    );
    expect(r.selected[0].excerpt.length).toBeLessThan(huge.length);
  });
});

describe("formatSkillInjection (bounded, attributed)", () => {
  it("is empty when nothing is selected (no prompt change)", () => {
    const r = routeSkillsForStage([], { stageName: "plan" });
    expect(formatSkillInjection(r.selected)).toBe("");
  });

  it("wraps selections with an attribution + repo-precedence note", () => {
    const sk = validated(
      { name: "tdd", version: "2.1.0", instructions: "Write the test first." },
      "afk-safe"
    );
    const r = routeSkillsForStage([sk], { stageName: "implementer" });
    const block = formatSkillInjection(r.selected);
    expect(block).toContain("<available-skills");
    expect(block).toContain("</available-skills>");
    expect(block).toContain("tdd");
    expect(block).toContain("Write the test first.");
    // Conflict / precedence guidance must be present.
    expect(block).toMatch(/repo policy|outrank|advisory/i);
  });

  it("attributes an imported skill with its source and ref", () => {
    const imported = validated(
      {
        name: "sp-tdd",
        instructions: "TDD.",
        provenance: {
          source: "superpowers",
          upstreamPath: "skills/tdd",
          upstreamRef: "abc1234",
          checksum: "deadbeefcafe",
          license: "MIT",
        },
      },
      "afk-safe"
    );
    const r = routeSkillsForStage([imported], { stageName: "implementer" });
    const block = formatSkillInjection(r.selected);
    expect(block).toContain("superpowers");
    expect(block).toContain("abc1234");
  });

  it("labels a repo-authored skill as source: repo", () => {
    const r = routeSkillsForStage([validated({ name: "local" }, "afk-safe")], {
      stageName: "plan",
    });
    expect(formatSkillInjection(r.selected)).toContain("repo");
  });
});

describe("toSkillUsages (evidence)", () => {
  it("converts selections to SkillUsage with stage, source, ref, reasons", () => {
    const imported = validated(
      {
        name: "sp",
        version: "1.0.0",
        provenance: {
          source: "superpowers",
          upstreamPath: "skills/sp",
          upstreamRef: "ref99",
          checksum: "sum",
        },
      },
      "afk-safe"
    );
    const r = routeSkillsForStage([imported], { stageName: "reviewer" });
    const usages = toSkillUsages(r.selected, "reviewer");
    expect(usages[0]).toMatchObject({
      name: "sp",
      version: "1.0.0",
      source: "superpowers",
      ref: "ref99",
      stage: "reviewer",
    });
    expect(usages[0].reasons?.length).toBeGreaterThan(0);
  });
});
