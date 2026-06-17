import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_DISPLAY_NAMES,
  DEFAULT_AGENT,
  parseAgentId,
  readAgentConfig,
  resolveAgentRuntime,
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
