import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatPlanReport,
  readTaskPlans,
  runPlanReport,
  type TaskPlanScore,
} from "../plan-report-cli.js";
import { scorePlanQuality } from "../plan-rubric.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-plan-report-"));
}

/** Write a task's spec/plan files under <ws>/.otto/tasks/<key>/. */
function writeTask(
  ws: string,
  key: string,
  files: { spec?: string; plan?: string }
): void {
  const dir = join(ws, ".otto", "tasks", key);
  mkdirSync(dir, { recursive: true });
  if (files.spec != null) writeFileSync(join(dir, "spec.md"), files.spec);
  if (files.plan != null) writeFileSync(join(dir, "plan.md"), files.plan);
}

const COMPLETE = [
  "## Problem",
  "It is broken.",
  "## Decisions",
  "We assume X. Rationale: cheapest.",
  "## Scope guard",
  "Non-goals: everything else.",
  "## File map",
  "- `packages/core/src/a.ts`",
  "- `packages/core/src/b.ts`",
  "## Tasks",
  "- [ ] 1. Write a failing test, then implement. verify: `pnpm -r test`",
  "- [ ] 2. Wire it. verify: `pnpm -r typecheck`",
  "## Success criteria",
  "Done when: testable. Testing notes: vitest.",
].join("\n");

function deps(cwd: string) {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    d: {
      env: { OTTO_WORKSPACE: cwd } as NodeJS.ProcessEnv,
      cwd,
      out: (m: string) => lines.push(m),
      err: (m: string) => errs.push(m),
    },
    lines,
    errs,
  };
}

describe("formatPlanReport", () => {
  it("renders a scorecard per task", () => {
    const tasks: TaskPlanScore[] = [
      { taskKey: "issue-1", score: scorePlanQuality(COMPLETE) },
      { taskKey: "issue-2", score: scorePlanQuality("# thin\njust do it") },
    ];
    const out = formatPlanReport(tasks);
    expect(out).toContain("Plan report");
    expect(out).toContain("Task issue-1");
    expect(out).toContain("Task issue-2");
    expect(out).toMatch(/8\/8/);
    expect(out).toMatch(/0\/8/);
    // the gate flags each task PASS/FAIL (slice 7): the complete plan passes,
    // the thin one fails.
    expect(out).toMatch(/plan gate: PASS/);
    expect(out).toMatch(/plan gate: FAIL/);
  });
});

describe("readTaskPlans", () => {
  it("scores each task dir with a spec/plan, sorted by key", () => {
    const ws = tmp();
    writeTask(ws, "issue-2", { plan: "# thin" });
    writeTask(ws, "issue-1", { spec: COMPLETE });
    const scored = readTaskPlans(ws);
    expect(scored.map((t) => t.taskKey)).toEqual(["issue-1", "issue-2"]);
    expect(scored[0].score.metCount).toBe(8);
  });

  it("concatenates spec + plan so criteria across both are credited", () => {
    const ws = tmp();
    // Split COMPLETE's content across the two files.
    writeTask(ws, "issue-1", {
      spec: "## Problem\nbroken\n## Scope guard\nNon-goals: x",
      plan: "## Tasks\n- [ ] 1. write a failing test. verify: `pnpm -r test`\n- [ ] 2. go",
    });
    const scored = readTaskPlans(ws);
    const ids = scored[0].score.results.filter((r) => r.met).map((r) => r.criterion);
    expect(ids).toContain("problem"); // from spec
    expect(ids).toContain("taskBreakdown"); // from plan
    expect(ids).toContain("scopeGuard");
  });

  it("skips an empty task dir and returns [] when none exist", () => {
    const ws = tmp();
    mkdirSync(join(ws, ".otto", "tasks", "empty"), { recursive: true });
    expect(readTaskPlans(ws)).toEqual([]);
    expect(readTaskPlans(tmp())).toEqual([]); // no .otto/tasks at all
  });
});

describe("runPlanReport", () => {
  it("errors with exit 1 when there are no task plans", async () => {
    const { d, errs } = deps(tmp());
    expect(await runPlanReport(d)).toBe(1);
    expect(errs.join("\n")).toMatch(/no task plans/i);
  });

  it("prints the report and exits 0 when plans exist", async () => {
    const ws = tmp();
    writeTask(ws, "issue-1", { spec: COMPLETE });
    const { d, lines } = deps(ws);
    expect(await runPlanReport(d)).toBe(0);
    expect(lines.join("\n")).toContain("Task issue-1");
  });
});
