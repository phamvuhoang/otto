import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "../render.js";
import { STAGES } from "../stages.js";
import { PLAN_CRITERIA } from "../plan-rubric.js";

// Render-contract tests for the P8 `plan` stage/template (issue #63). The stage
// is registered but not yet wired into any chain (slice 5), so these pin the
// registry entry, the template's authoring contract, and that the template's
// own instructions enumerate the sections the plan-quality rubric scores — i.e.
// a plan authored to this template is built to pass the rubric.

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

function render(vars: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-plan-stage-"));
  try {
    return renderTemplate(
      tpl("plan.md"),
      { INPUTS: "Build a thing", RESUME: "", ...vars },
      { spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("plan stage registry", () => {
  it("registers the plan stage pointing at plan.md with bypassPermissions", () => {
    expect(STAGES.plan).toMatchObject({
      name: "plan",
      template: "plan.md",
      permissionMode: "bypassPermissions",
    });
  });
});

describe("plan template", () => {
  it("scopes to authoring: no implementation, persists spec + plan, keeps the gate sentinel", () => {
    const out = render();
    expect(out).toContain("Build a thing"); // {{ INPUTS }} surfaced
    expect(out).toContain(".otto/tasks/<task-key>/spec.md");
    expect(out).toContain(".otto/tasks/<task-key>/plan.md");
    expect(out).toMatch(/NO source edits|DO NOT IMPLEMENT/);
    expect(out).toContain("NO MORE TASKS"); // gate-compatible
  });

  it("instructs the agent to author every rubric section, so plans are built to score well", () => {
    // The template is INSTRUCTIONS (not a populated plan), so we assert it calls
    // out each rubric criterion's section/keyword — one cross-check per criterion
    // in PLAN_CRITERIA, so adding a criterion forces updating the template.
    const out = render().toLowerCase();
    const must: Record<string, RegExp> = {
      problem: /## problem/,
      decisions: /## decisions|assumptions/,
      scopeGuard: /## scope guard|non-goals/,
      fileMap: /## file map|component\/file map/,
      taskBreakdown: /- \[ \]|checklist/,
      testFirst: /failing-test-first|failing test/,
      verifyCommands: /verify/,
      successCriteria: /success criteria|testing notes/,
    };
    for (const c of PLAN_CRITERIA) {
      expect(must[c.criterion], `template must enumerate ${c.criterion}`).toBeDefined();
      expect(out).toMatch(must[c.criterion]);
    }
  });
});
