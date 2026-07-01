import { describe, expect, it } from "vitest";

import { parseTool } from "../tools.js";
import { parseSource } from "../external-skills.js";
import {
  EXTENSION_PROFILES,
  getProfile,
  listProfiles,
} from "../extension-profiles.js";

describe("extension profile manifests", () => {
  it("ships the four curated profiles", () => {
    const names = listProfiles()
      .map((p) => p.name)
      .sort();
    expect(names).toEqual([
      "coding-superpowers",
      "context-saver",
      "pm-planning",
      "security-review",
    ]);
  });

  it("getProfile returns a known profile and null otherwise", () => {
    expect(getProfile("coding-superpowers")?.name).toBe("coding-superpowers");
    expect(getProfile("nope")).toBeNull();
  });

  it("every profile has a name + description and does something", () => {
    for (const p of listProfiles()) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      const acts =
        p.sources.length + p.tools.length + Object.keys(p.config).length;
      expect(acts).toBeGreaterThan(0);
    }
  });

  it("every declared source is well-formed and git/archive sources are pinned", () => {
    for (const p of listProfiles()) {
      for (const s of p.sources) {
        expect(parseSource(s)).not.toBeNull();
        if (s.type === "git" || s.type === "archive") {
          expect(s.ref && s.ref.length > 0).toBe(true);
        }
      }
    }
  });

  it("every declared tool parses as a valid ToolDefinition", () => {
    for (const p of listProfiles()) {
      for (const t of p.tools) {
        expect(parseTool(t)?.name).toBe(t.name);
      }
    }
  });

  it("coding-superpowers registers Superpowers and activates implement/review skills", () => {
    const p = getProfile("coding-superpowers")!;
    expect(p.sources.some((s) => /superpowers/i.test(s.location))).toBe(true);
    expect((p.config.skills as Record<string, unknown>)?.enabled).toBe(true);
  });

  it("context-saver wires the Headroom tool + the compressor default", () => {
    const p = getProfile("context-saver")!;
    expect(p.tools.some((t) => t.name === "headroom")).toBe(true);
    expect(p.config.contextCompressor).toBe("headroom");
    // Must require the [ml] extra — base headroom-ai leaves plain text unchanged.
    expect(p.requires).toContain("headroom-ai[ml]");
    expect(p.requires).not.toContain("headroom-ai"); // not the bare/base package
  });

  it("security-review tightens the safety policy", () => {
    const p = getProfile("security-review")!;
    expect(p.policy).toBeDefined();
  });
});
