import { describe, expect, it } from "vitest";
import {
  boundResumeNote,
  RESUME_NOTE_MAX_CHARS,
  enforceContextBudget,
  summarizeEnforcement,
  type EnforcementHooks,
} from "../context-enforcement.js";

const prompt = (parts: {
  learnings?: string;
  commits?: string;
  evidence?: string;
  inputs?: string;
  playbook?: string;
}): string =>
  [
    parts.playbook ?? "PLAYBOOK: do the work carefully.",
    `<commits>\n\n${parts.commits ?? "c"}\n\n</commits>`,
    `<learnings>\n\n${parts.learnings ?? "l"}\n\n</learnings>`,
    `<issue>\n\n${parts.evidence ?? "e"}\n\n</issue>`,
    `<inputs>\n\n${parts.inputs ?? "i"}\n\n</inputs>`,
  ].join("\n\n");

describe("boundResumeNote", () => {
  const SECTIONS = [
    "The authored plan failed Otto's semantic plan gate. Re-plan once before stopping.",
    `GATE DETAIL ${"g".repeat(1500)}`,
    `DEPTH RUBRIC ${"d".repeat(1500)}`,
    "Rewrite spec.md and plan.md; keep the same task key unless the original key was wrong.",
  ];
  const note = SECTIONS.join("\n\n");

  it("keeps a short note verbatim", () => {
    expect(boundResumeNote("short note")).toBe("short note");
  });

  it("NEVER drops the actionable instruction, which is LAST", () => {
    // Head-preserving truncation would cut exactly this sentence and leave the
    // agent a diagnosis with nothing to act on.
    const out = boundResumeNote(note);
    expect(out.length).toBeLessThanOrEqual(RESUME_NOTE_MAX_CHARS);
    expect(out).toContain("Rewrite spec.md and plan.md");
  });

  it("drops the bulky rubric before the lead sentence", () => {
    const out = boundResumeNote(note);
    expect(out).not.toContain("DEPTH RUBRIC");
    expect(out).toContain("failed Otto's semantic plan gate");
  });

  it("says what it dropped", () => {
    expect(boundResumeNote(note)).toMatch(/omitted|dropped|trimmed/i);
  });
});

describe("enforceContextBudget", () => {
  const hooks = (over: Partial<EnforcementHooks> = {}): EnforcementHooks => ({
    renderBoundedLearnings: () => "BOUNDED LEARNINGS",
    ...over,
  });

  it("is inert when the prompt is within budget", () => {
    const p = prompt({});
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 1_000_000,
      hooks: hooks(),
    });
    expect(out.prompt).toBe(p);
    expect(out.events).toEqual([]);
  });

  it("pulls the learnings lever when over budget", () => {
    const p = prompt({ learnings: "L".repeat(40_000) });
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 500,
      hooks: hooks(),
    });
    expect(out.events.some((e) => e.lever === "bound-learnings")).toBe(true);
    expect(out.prompt).toContain("BOUNDED LEARNINGS");
    expect(out.prompt.length).toBeLessThan(p.length);
  });

  it("NEVER touches inputs or playbook", () => {
    const p = prompt({
      learnings: "L".repeat(40_000),
      inputs: "THE ACTUAL TASK",
      playbook: "PLAYBOOK: do the work carefully.",
    });
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 500,
      hooks: hooks(),
    });
    expect(out.prompt).toContain("THE ACTUAL TASK");
    expect(out.prompt).toContain("PLAYBOOK: do the work carefully.");
  });

  it("discards a rewrite that would violate the invariants (fail closed)", () => {
    const p = prompt({ learnings: "L".repeat(40_000), inputs: "THE TASK" });
    // A hook that returns something destroying the <inputs> block.
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 500,
      hooks: hooks({
        renderBoundedLearnings: () => "x</inputs><inputs>",
      }),
    });
    expect(out.prompt).toBe(p); // original, unmodified
    expect(out.events.some((e) => e.skipped === "invariant-violation")).toBe(
      true
    );
  });

  it("records still-over rather than truncating when no lever is enough", () => {
    const p = prompt({ inputs: "I".repeat(80_000) });
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 100,
      hooks: hooks(),
    });
    expect(out.prompt).toContain("I".repeat(80_000)); // untouched
    expect(out.assessment.overBudget).toBe(true);
  });

  it("skips a lever with no hook rather than failing", () => {
    const p = prompt({ learnings: "L".repeat(40_000) });
    const out = enforceContextBudget(p, {
      stage: "implementer",
      maxTokens: 500,
      hooks: {},
    });
    expect(out.prompt).toBe(p);
    expect(out.events.some((e) => e.skipped === "lever-unavailable")).toBe(
      true
    );
  });
});

describe("summarizeEnforcement", () => {
  it("tallies applications and measured savings by lever", () => {
    const s = summarizeEnforcement([
      {
        lever: "bound-learnings",
        beforeTokens: 100,
        afterTokens: 60,
        stage: "a",
      },
      {
        lever: "compact-commits",
        beforeTokens: 60,
        afterTokens: 50,
        stage: "a",
      },
      {
        lever: "compress-spill",
        beforeTokens: 50,
        afterTokens: 50,
        stage: "a",
        skipped: "lever-unavailable",
      },
    ]);
    expect(s.applications).toBe(2); // the skipped one is not an application
    expect(s.tokensSaved).toBe(50);
    expect(s.byLever["bound-learnings"]).toBe(40);
  });

  it("is empty for a run that never enforced", () => {
    expect(summarizeEnforcement([])).toEqual({
      applications: 0,
      tokensSaved: 0,
      byLever: {},
    });
  });
});
