import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  recordStaticValidation,
  recordValidation,
  skillInstructionsPath,
  writeSkill,
  type Skill,
} from "../skills.js";
import { skillChecksum } from "../skill-validation.js";
import {
  ReviewSkillError,
  resolveReviewSkill,
  type ReviewSkillSelection,
} from "../pr-review-skill.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-pr-review-skill-"));
}

function baseSkill(over: Partial<Skill> = {}): Skill {
  return {
    name: "review-helper",
    version: "2.0.0",
    capabilities: ["code-review"],
    constraints: [],
    scope: [],
    instructions: "Review the diff carefully and flag defects.",
    scripts: {},
    tests: [],
    validation: {},
    trust: "unverified",
    createdAt: "2026-06-19T00:00:00.000Z",
    useCount: 0,
    ...over,
  };
}

const NOW = new Date("2026-07-18T00:00:00.000Z");

/** A skill statically validated to `compatibility`/`stages`, and run-validated
 *  (so `skillStatus` reports "validated"), body checksum in sync. */
function eligibleSkill(
  over: Partial<Skill>,
  compatibility: "afk-safe" | "stage-scoped" | "interactive-only" | "blocked",
  stages: string[] = []
): Skill {
  const s0 = baseSkill(over);
  const staticked = recordStaticValidation(
    s0,
    { compatibility, stages, checksum: skillChecksum(s0.instructions) },
    NOW
  );
  return recordValidation(staticked, "run-1", NOW);
}

describe("resolveReviewSkill — built-in default (no override)", () => {
  it("returns the built-in skill with a deterministic checksum and empty injection", () => {
    const ws = tmp();
    const a = resolveReviewSkill({ workspaceDir: ws, changedPaths: [] });
    const b = resolveReviewSkill({ workspaceDir: ws, changedPaths: [] });
    expect(a.name).toBe("builtin:otto-code-review");
    expect(a.version).toBe("1");
    expect(a.source).toBe("builtin");
    expect(a.injection).toBe("");
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(a.checksum).toBe(b.checksum); // deterministic, reproducible
    expect(a.usage).toEqual({
      name: "builtin:otto-code-review",
      version: "1",
      source: "builtin",
      stage: "pr-review",
      checksum: a.checksum,
    });
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("resolveReviewSkill — explicit requested skill rejections", () => {
  it("throws when the requested package is missing", () => {
    const ws = tmp();
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "nope",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when the skill is unvalidated (skillStatus !== validated)", () => {
    const ws = tmp();
    writeSkill(ws, baseSkill({ name: "unvalidated", validation: {} }));
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "unvalidated",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when the skill has no static compatibility recorded", () => {
    const ws = tmp();
    // Run-validated (lastValidatedRun set) but never through the static gate.
    const s = recordValidation(baseSkill({ name: "no-compat" }), "run-1", NOW);
    writeSkill(ws, s);
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "no-compat",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when the skill is blocked", () => {
    const ws = tmp();
    writeSkill(ws, eligibleSkill({ name: "blocked-skill" }, "blocked"));
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "blocked-skill",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when the skill is interactive-only", () => {
    const ws = tmp();
    writeSkill(
      ws,
      eligibleSkill({ name: "interactive-skill" }, "interactive-only")
    );
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "interactive-skill",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when stage-scoped but not to review", () => {
    const ws = tmp();
    writeSkill(
      ws,
      eligibleSkill({ name: "plan-only" }, "stage-scoped", ["plan"])
    );
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "plan-only",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws on checksum drift (needsRevalidation)", () => {
    const ws = tmp();
    const s = eligibleSkill({ name: "drifty" }, "afk-safe");
    writeSkill(ws, s);
    // Simulate the body changing after validation — the recorded checksum in
    // skill.json no longer matches instructions.md.
    writeFileSync(
      skillInstructionsPath(ws, "drifty"),
      "A completely different body now."
    );
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "drifty",
        changedPaths: [],
      })
    ).toThrow(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it("throws when a risk constraint excludes the skill from the changed paths", () => {
    const ws = tmp();
    writeSkill(
      ws,
      eligibleSkill(
        {
          name: "sec-excluded",
          constraints: ["no security-sensitive changes"],
        },
        "afk-safe"
      )
    );
    expect(() =>
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "sec-excluded",
        changedPaths: ["packages/core/src/auth.ts"],
      })
    ).toThrow(ReviewSkillError);
    try {
      resolveReviewSkill({
        workspaceDir: ws,
        requested: "sec-excluded",
        changedPaths: ["packages/core/src/auth.ts"],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewSkillError);
      expect((err as Error).message).toMatch(/security-sensitive/);
    }
    rmSync(ws, { recursive: true, force: true });
  });

  it("never falls back to the built-in after an explicit request fails", () => {
    const ws = tmp();
    // No skill package at all under this name.
    let selection: ReviewSkillSelection | undefined;
    let thrown: unknown;
    try {
      selection = resolveReviewSkill({
        workspaceDir: ws,
        requested: "does-not-exist",
        changedPaths: [],
      });
    } catch (err) {
      thrown = err;
    }
    expect(selection).toBeUndefined();
    expect(thrown).toBeInstanceOf(ReviewSkillError);
    rmSync(ws, { recursive: true, force: true });
  });

  it(
    "documents that a single explicitly-requested skill can never be dropped " +
      "purely for exceeding the char budget under the fixed defaults " +
      "(DEFAULT_PER_SKILL_CHARS=1200 < DEFAULT_SKILLS_BUDGET_CHARS=4000) — a " +
      "huge instruction body is truncated, not rejected, and still selected",
    () => {
      const ws = tmp();
      const huge = "x".repeat(10_000);
      writeSkill(
        ws,
        eligibleSkill({ name: "huge", instructions: huge }, "afk-safe")
      );
      const selection = resolveReviewSkill({
        workspaceDir: ws,
        requested: "huge",
        changedPaths: [],
      });
      expect(selection.name).toBe("huge");
      expect(selection.injection.length).toBeLessThan(huge.length);
      rmSync(ws, { recursive: true, force: true });
    }
  );
});

describe("resolveReviewSkill — successful explicit repo skill", () => {
  it("resolves a validated, compatible repo skill with attribution + one SkillUsage", () => {
    const ws = tmp();
    const s = eligibleSkill(
      { name: "reviewer-helper", capabilities: ["code-review"] },
      "afk-safe"
    );
    writeSkill(ws, s);
    const selection = resolveReviewSkill({
      workspaceDir: ws,
      requested: "reviewer-helper",
      changedPaths: [],
      now: NOW,
    });
    expect(selection.name).toBe("reviewer-helper");
    expect(selection.version).toBe("2.0.0");
    expect(selection.source).toBe("repo");
    expect(selection.checksum).toBe(skillChecksum(s.instructions));
    expect(selection.injection).toContain("reviewer-helper");
    expect(selection.usage).toEqual({
      name: "reviewer-helper",
      version: "2.0.0",
      source: "repo",
      stage: "pr-review",
      reasons: expect.any(Array),
      checksum: selection.checksum,
    });
    rmSync(ws, { recursive: true, force: true });
  });

  it("attributes an imported skill's source/ref in the selection and usage", () => {
    const ws = tmp();
    const s = eligibleSkill(
      {
        name: "imported-reviewer",
        capabilities: ["review"],
        provenance: {
          source: "org/skills",
          upstreamPath: "reviewer",
          upstreamRef: "v1.2.3",
          checksum: "deadbeef",
        },
      },
      "stage-scoped",
      ["review"]
    );
    writeSkill(ws, s);
    const selection = resolveReviewSkill({
      workspaceDir: ws,
      requested: "imported-reviewer",
      changedPaths: [],
      now: NOW,
    });
    expect(selection.source).toBe("org/skills");
    expect(selection.usage.ref).toBe("v1.2.3");
    expect(selection.usage.source).toBe("org/skills");
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("resolveReviewSkill — fail-closed ordering (no paid model call)", () => {
  /** Mimics how a future caller wires this in: resolve first, only then
   *  invoke the (expensive) analysis callback. */
  function runReviewStageStub(
    opts: Parameters<typeof resolveReviewSkill>[0],
    analyze: () => void
  ): ReviewSkillSelection {
    const selection = resolveReviewSkill(opts);
    analyze();
    return selection;
  }

  it("never invokes the analysis callback when selection fails", () => {
    const ws = tmp();
    const analyze = vi.fn();
    expect(() =>
      runReviewStageStub(
        { workspaceDir: ws, requested: "missing", changedPaths: [] },
        analyze
      )
    ).toThrow(ReviewSkillError);
    expect(analyze).not.toHaveBeenCalled();
    rmSync(ws, { recursive: true, force: true });
  });

  it("invokes the analysis callback only after a successful selection", () => {
    const ws = tmp();
    const analyze = vi.fn();
    const selection = runReviewStageStub(
      { workspaceDir: ws, changedPaths: [] },
      analyze
    );
    expect(selection.name).toBe("builtin:otto-code-review");
    expect(analyze).toHaveBeenCalledTimes(1);
    rmSync(ws, { recursive: true, force: true });
  });
});
