import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_DISPLAY_NAMES,
  DEFAULT_AGENT,
  parseAgentId,
  readAgentConfig,
  readFallbackConfig,
  resolveAgentRuntime,
  resolveFallback,
} from "../agent-runtime.js";

describe("parseAgentId", () => {
  it("accepts the known runtime ids (trimmed)", () => {
    expect(parseAgentId("claude", "--agent")).toBe("claude");
    expect(parseAgentId(" codex ", "--agent")).toBe("codex");
  });

  it("throws a clean error on an unknown id, naming the source", () => {
    expect(() => parseAgentId("gpt", "OTTO_AGENT")).toThrow(
      /OTTO_AGENT must be one of claude\|codex/
    );
    expect(() => parseAgentId("", "--agent")).toThrow(/--agent/);
  });
});

describe("resolveAgentRuntime", () => {
  it("defaults to claude when nothing is set", () => {
    expect(resolveAgentRuntime({})).toEqual({
      id: "claude",
      displayName: "Claude Code",
      source: "default",
    });
    expect(DEFAULT_AGENT).toBe("claude");
    expect(AGENT_DISPLAY_NAMES.codex).toBe("Codex CLI");
  });

  it("honors precedence flag > env > config > default", () => {
    expect(
      resolveAgentRuntime({ flag: "codex", env: "claude", config: "claude" })
        .source
    ).toBe("flag");
    expect(
      resolveAgentRuntime({ env: "codex", config: "claude" })
    ).toMatchObject({ id: "codex", source: "env" });
    expect(resolveAgentRuntime({ config: "codex" })).toMatchObject({
      id: "codex",
      source: "config",
    });
  });

  it("ignores blank env/config and falls through", () => {
    expect(resolveAgentRuntime({ env: "  ", config: "" }).source).toBe(
      "default"
    );
  });

  it("throws on an invalid env or config value", () => {
    expect(() => resolveAgentRuntime({ env: "bogus" })).toThrow(/OTTO_AGENT/);
    expect(() => resolveAgentRuntime({ config: "bogus" })).toThrow(
      /config\.json/
    );
  });
});

describe("resolveFallback", () => {
  it("defaults OFF — no fallback agent, no auto-switch", () => {
    expect(resolveFallback({})).toEqual({ autoSwitch: false });
  });

  it("resolves the fallback agent by flag > env > config", () => {
    expect(
      resolveFallback({ flagAgent: "codex", envAgent: "claude" }).agent
    ).toMatchObject({ id: "codex", source: "flag" });
    expect(resolveFallback({ envAgent: "codex" }).agent).toMatchObject({
      id: "codex",
      source: "env",
    });
    expect(resolveFallback({ configAgent: "codex" }).agent).toMatchObject({
      id: "codex",
      source: "config",
    });
  });

  it("ignores a blank fallback-agent env/config (stays unset)", () => {
    expect(resolveFallback({ envAgent: "  ", configAgent: "" }).agent).toBeUndefined();
  });

  it("throws on an invalid fallback-agent env or config value", () => {
    expect(() => resolveFallback({ envAgent: "gpt" })).toThrow(
      /OTTO_FALLBACK_AGENT/
    );
    expect(() => resolveFallback({ configAgent: "gpt" })).toThrow(
      /fallbackAgent/
    );
  });

  it("resolves auto-switch by flag > env > config (truthy env values)", () => {
    expect(resolveFallback({ flagAutoSwitch: true }).autoSwitch).toBe(true);
    expect(resolveFallback({ envAutoSwitch: "1" }).autoSwitch).toBe(true);
    expect(resolveFallback({ envAutoSwitch: "true" }).autoSwitch).toBe(true);
    expect(resolveFallback({ envAutoSwitch: "0" }).autoSwitch).toBe(false);
    expect(resolveFallback({ envAutoSwitch: "nonsense" }).autoSwitch).toBe(false);
    expect(resolveFallback({ configAutoSwitch: true }).autoSwitch).toBe(true);
  });

  it("lets an explicit env value override config; blank env falls through", () => {
    expect(
      resolveFallback({ envAutoSwitch: "0", configAutoSwitch: true }).autoSwitch
    ).toBe(false);
    expect(
      resolveFallback({ envAutoSwitch: "  ", configAutoSwitch: true }).autoSwitch
    ).toBe(true);
  });
});

describe("readFallbackConfig", () => {
  let cfgDir: string;
  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "otto-fallback-"));
  });
  afterEach(() => {
    rmSync(cfgDir, { recursive: true, force: true });
  });

  function writeCfg(obj: unknown): void {
    mkdirSync(join(cfgDir, ".otto"), { recursive: true });
    writeFileSync(join(cfgDir, ".otto", "config.json"), JSON.stringify(obj));
  }

  it("reads fallbackAgent (string) and autoSwitchOnLimit (bool)", () => {
    writeCfg({ fallbackAgent: "codex", autoSwitchOnLimit: true });
    expect(readFallbackConfig(cfgDir)).toEqual({
      agent: "codex",
      autoSwitch: true,
    });
  });

  it("returns {} when absent, malformed, or wrong types", () => {
    expect(readFallbackConfig(cfgDir)).toEqual({});
    writeCfg({ fallbackAgent: 42, autoSwitchOnLimit: "yes" });
    expect(readFallbackConfig(cfgDir)).toEqual({});
  });
});

describe("readAgentConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otto-agent-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): void {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), JSON.stringify(obj));
  }

  it("returns the agent field when it is a string", () => {
    writeConfig({ agent: "codex", branchPrefix: "otto/" });
    expect(readAgentConfig(dir)).toBe("codex");
  });

  it("returns undefined when absent, malformed, or non-string", () => {
    expect(readAgentConfig(dir)).toBeUndefined();
    writeConfig({ branchPrefix: "otto/" });
    expect(readAgentConfig(dir)).toBeUndefined();
    writeConfig({ agent: 42 });
    expect(readAgentConfig(dir)).toBeUndefined();
  });
});
