import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatSkillsReport,
  formatWhy,
  runSkills,
} from "../skills-cli.js";
import { writeManifest, type RunManifest } from "../run-report.js";
import { recordValidation, selectSkills, writeSkill, type Skill } from "../skills.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-skills-cli-"));
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: "release-flow",
    version: "1.0.0",
    capabilities: ["release"],
    constraints: [],
    scope: ["packages/core/**"],
    instructions: "do it",
    scripts: {},
    tests: [],
    validation: {},
    trust: "unverified",
    createdAt: "2026-06-19T00:00:00.000Z",
    useCount: 0,
    ...over,
  };
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "r",
    bin: "otto-afk",
    mode: "afk",
    inputs: "release.md",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 3,
    completedIterations: 3,
    costUsd: 1,
    tokenUsage: emptyTokenUsage(),
    exitReason: "complete",
    artifacts: [],
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:01:00.000Z",
    ...over,
  };
}

describe("pure formatters", () => {
  it("formatSkillsReport shows status, capabilities, and scope", () => {
    const out = formatSkillsReport([
      recordValidation(skill({ name: "ready" }), "run-1", new Date("2026-06-19T00:00:00.000Z")),
    ]);
    expect(out).toContain("ready@1.0.0");
    expect(out).toContain("[validated/unverified]");
    expect(out).toContain("release");
    expect(out).toContain("packages/core/**");
  });

  it("formatSkillsReport handles an empty inventory", () => {
    expect(formatSkillsReport([])).toMatch(/no skills/i);
  });

  it("formatWhy lists eligibility and reasons per skill", () => {
    const matches = selectSkills([skill({ name: "s", validation: {} })], {
      changedPaths: ["packages/core/src/eval.ts"],
    });
    const out = formatWhy(matches);
    expect(out).toContain("s");
    expect(out).toMatch(/skip/);
    expect(out).toMatch(/validation required/);
  });
});

describe("runSkills", () => {
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

  it("lists skills (default subcommand)", async () => {
    const ws = tmp();
    writeSkill(ws, skill({ name: "a-skill" }));
    const { d, lines } = deps(ws);
    expect(await runSkills([], d)).toBe(0);
    expect(lines.join("\n")).toContain("a-skill");
    rmSync(ws, { recursive: true, force: true });
  });

  it("audits validated vs unvalidated", async () => {
    const ws = tmp();
    writeSkill(ws, recordValidation(skill({ name: "ok" }), "run-1"));
    writeSkill(ws, skill({ name: "pending", validation: {} }));
    const { d, lines } = deps(ws);
    expect(await runSkills(["audit"], d)).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/validated:\s+1/);
    expect(out).toMatch(/unvalidated:\s+1/);
    expect(out).toContain("pending");
    rmSync(ws, { recursive: true, force: true });
  });

  it("explains why for given changed paths", async () => {
    const ws = tmp();
    writeSkill(ws, recordValidation(skill({ name: "core-skill", scope: ["packages/core/**"] }), "r1"));
    const { d, lines } = deps(ws);
    expect(await runSkills(["why", "packages/core/src/eval.ts"], d)).toBe(0);
    expect(lines.join("\n")).toMatch(/eligible/);
    rmSync(ws, { recursive: true, force: true });
  });

  it("errors when 'why' is given no paths", async () => {
    const { d, errs } = deps(tmp());
    expect(await runSkills(["why"], d)).toBe(1);
    expect(errs.join("\n")).toMatch(/at least one changed path/);
  });

  it("suggests candidates from repeated successful runs", async () => {
    const ws = tmp();
    writeManifest(ws, manifest({ runId: "a1", inputs: "release.md" }));
    writeManifest(ws, manifest({ runId: "a2", inputs: "release.md" }));
    const { d, lines } = deps(ws);
    expect(await runSkills(["candidates"], d)).toBe(0);
    expect(lines.join("\n")).toMatch(/2 successful runs/);
    rmSync(ws, { recursive: true, force: true });
  });

  it("rejects an unknown subcommand and prints usage on --help", async () => {
    const bad = deps(tmp());
    expect(await runSkills(["bogus"], bad.d)).toBe(1);
    expect(bad.errs.join("\n")).toMatch(/unknown subcommand/i);
    const help = deps(tmp());
    expect(await runSkills(["--help"], help.d)).toBe(0);
    expect(help.lines.join("\n")).toMatch(/usage: otto-skills/i);
  });
});
