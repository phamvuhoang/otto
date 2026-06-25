import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSkillsConfig,
  resolveSkillActivation,
  stageEnabled,
  type SkillActivation,
} from "../skill-activation.js";

function tmpWorkspace(config?: unknown): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-skill-act-"));
  if (config !== undefined) {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(
      join(ws, ".otto", "config.json"),
      JSON.stringify(config, null, 2)
    );
  }
  return ws;
}

describe("resolveSkillActivation", () => {
  it("is disabled by default (no flag, no env, no config)", () => {
    const a = resolveSkillActivation({});
    expect(a.enabled).toBe(false);
  });

  it("enables via the --use-skills flag", () => {
    expect(resolveSkillActivation({ flag: true }).enabled).toBe(true);
  });

  it("enables via OTTO_USE_SKILLS=1", () => {
    expect(resolveSkillActivation({ env: "1" }).enabled).toBe(true);
    expect(resolveSkillActivation({ env: "true" }).enabled).toBe(true);
    expect(resolveSkillActivation({ env: "0" }).enabled).toBe(false);
  });

  it("enables via config.skills.enabled", () => {
    expect(resolveSkillActivation({ config: { enabled: true } }).enabled).toBe(
      true
    );
  });

  it("flag and env outrank a config that disables", () => {
    expect(
      resolveSkillActivation({ flag: true, config: { enabled: false } }).enabled
    ).toBe(true);
  });

  it("carries per-stage-family overrides from config", () => {
    const a = resolveSkillActivation({
      config: { enabled: true, plan: true, review: false },
    });
    expect(a.stages.plan).toBe(true);
    expect(a.stages.review).toBe(false);
    expect(a.stages.implement).toBeUndefined();
  });
});

describe("stageEnabled", () => {
  const base: SkillActivation = { enabled: true, stages: {} };

  it("is false everywhere when activation is disabled", () => {
    expect(
      stageEnabled({ enabled: false, stages: { plan: true } }, "plan")
    ).toBe(false);
  });

  it("defaults a family to the global switch when it has no override", () => {
    expect(stageEnabled(base, "implement")).toBe(true);
  });

  it("respects an explicit per-family override", () => {
    expect(
      stageEnabled({ enabled: true, stages: { review: false } }, "review")
    ).toBe(false);
    expect(
      stageEnabled({ enabled: true, stages: { plan: true } }, "plan")
    ).toBe(true);
  });
});

describe("readSkillsConfig", () => {
  it("returns the raw skills block or undefined", () => {
    const ws = tmpWorkspace({ skills: { enabled: true, plan: true } });
    expect(readSkillsConfig(ws)).toEqual({ enabled: true, plan: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns undefined on a missing or malformed config", () => {
    const ws = tmpWorkspace();
    expect(readSkillsConfig(ws)).toBeUndefined();
    rmSync(ws, { recursive: true, force: true });
  });
});
