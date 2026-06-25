import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getProfile, listProfiles } from "../extension-profiles.js";
import { applyProfile, planProfile, runExtensions } from "../extensions-cli.js";
import {
  auditExternal,
  importedChecksum,
  readLock,
  readSources,
} from "../external-skills.js";
import { readTools } from "../tools.js";
import { readSafetyPolicy } from "../safety-policy.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-ext-"));
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("planProfile", () => {
  it("lists what would be written, touching nothing", () => {
    const ws = tmp();
    const plan = planProfile(ws, getProfile("context-saver")!);
    expect(
      plan.items.some((i) => i.kind === "tool" && i.target === "headroom")
    ).toBe(true);
    expect(plan.items.some((i) => i.kind === "config")).toBe(true);
    // Dry plan writes nothing.
    expect(existsSync(join(ws, ".otto", "tools", "headroom.json"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("applyProfile", () => {
  it("writes a pinned source + activation config for coding-superpowers", () => {
    const ws = tmp();
    applyProfile(ws, getProfile("coding-superpowers")!);
    const sources = readSources(ws);
    expect(sources.find((s) => s.name === "superpowers")?.ref).toBeTruthy();
    const cfg = readJson(join(ws, ".otto", "config.json"));
    expect((cfg.skills as Record<string, unknown>).enabled).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  it("writes the Headroom tool + compressor config for context-saver", () => {
    const ws = tmp();
    applyProfile(ws, getProfile("context-saver")!);
    expect(readTools(ws).some((t) => t.name === "headroom")).toBe(true);
    const cfg = readJson(join(ws, ".otto", "config.json"));
    expect(cfg.contextCompressor).toBe("headroom");
    rmSync(ws, { recursive: true, force: true });
  });

  it("merges policy as a union, never relaxing existing rules", () => {
    const ws = tmp();
    applyProfile(ws, getProfile("security-review")!);
    const policy = readSafetyPolicy(ws);
    expect(policy.blockedCommands.length).toBeGreaterThan(0);
    expect(policy.approvalRequiredActions).toContain("git push --force");
    rmSync(ws, { recursive: true, force: true });
  });

  it("merges config without clobbering unrelated existing keys", () => {
    const ws = tmp();
    // Pre-existing config with an unrelated key + a skills sub-key.
    applyProfile(ws, getProfile("pm-planning")!);
    // Apply a second profile; the merge must keep both skills families.
    applyProfile(ws, getProfile("security-review")!);
    const cfg = readJson(join(ws, ".otto", "config.json"));
    const skills = cfg.skills as Record<string, unknown>;
    expect(skills.plan).toBe(true); // from pm-planning
    expect(skills.review).toBe(true); // from security-review
    rmSync(ws, { recursive: true, force: true });
  });

  it("is idempotent — applying twice does not duplicate the source", () => {
    const ws = tmp();
    applyProfile(ws, getProfile("coding-superpowers")!);
    applyProfile(ws, getProfile("coding-superpowers")!);
    expect(readSources(ws).filter((s) => s.name === "superpowers").length).toBe(
      1
    );
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("runExtensions", () => {
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

  it("lists the curated profiles", async () => {
    const { d, lines } = deps(tmp());
    expect(await runExtensions(["list"], d)).toBe(0);
    expect(lines.join("\n")).toMatch(/coding-superpowers/);
    expect(lines.join("\n")).toMatch(/context-saver/);
  });

  it("init --dry-run previews without writing", async () => {
    const ws = tmp();
    const { d, lines } = deps(ws);
    expect(await runExtensions(["init", "context-saver", "--dry-run"], d)).toBe(
      0
    );
    expect(lines.join("\n")).toMatch(/dry.run|preview/i);
    expect(existsSync(join(ws, ".otto", "tools", "headroom.json"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  it("init writes the profile and reports the follow-up", async () => {
    const ws = tmp();
    const { d, lines } = deps(ws);
    expect(await runExtensions(["init", "context-saver"], d)).toBe(0);
    expect(existsSync(join(ws, ".otto", "tools", "headroom.json"))).toBe(true);
    expect(lines.join("\n")).toMatch(/headroom/);
    rmSync(ws, { recursive: true, force: true });
  });

  it("errors on an unknown profile and lists valid ones", async () => {
    const { d, errs } = deps(tmp());
    expect(await runExtensions(["init", "bogus"], d)).toBe(1);
    expect(errs.join("\n")).toMatch(/coding-superpowers/);
  });

  it("errors when init names no profile", async () => {
    const { d, errs } = deps(tmp());
    expect(await runExtensions(["init"], d)).toBe(1);
    expect(errs.join("\n")).toMatch(/profile/i);
  });
});

describe("profile smoke (P21 success criteria)", () => {
  it("every profile's generated external registry is audit-clean", () => {
    for (const p of listProfiles()) {
      const ws = tmp();
      applyProfile(ws, p);
      const findings = auditExternal(readSources(ws), readLock(ws), (s) =>
        importedChecksum(ws, s)
      );
      expect(
        findings,
        `${p.name} should produce no external-registry findings`
      ).toEqual([]);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("every profile's generated tools parse as valid definitions", () => {
    for (const p of listProfiles()) {
      const ws = tmp();
      applyProfile(ws, p);
      const tools = readTools(ws);
      expect(tools.length).toBe(p.tools.length);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
