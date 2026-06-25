import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type SafetyPolicy } from "../safety-policy.js";
import {
  authorizeToolInvocation,
  parseTool,
  readToolConfig,
  readTools,
  selectToolsForStage,
  toolEnabledForStage,
  type ToolConfig,
  type ToolDefinition,
} from "../tools.js";

let work: string;

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "headroom",
    kind: "command",
    capabilities: ["compression"],
    stages: ["review"],
    env: [],
    networkDomains: [],
    writeRoots: [],
    secretRefs: [],
    approvalActions: [],
    enabled: true,
    ...overrides,
  };
}

const noOverrides: ToolConfig = { overrides: {} };

function writeTool(name: string, def: Record<string, unknown>): void {
  writeFileSync(
    join(work, ".otto", "tools", `${name}.json`),
    JSON.stringify(def)
  );
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "otto-tools-"));
  mkdirSync(join(work, ".otto", "tools"), { recursive: true });
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("parseTool", () => {
  it("fills restrictive defaults and drops nameless", () => {
    const t = parseTool({ name: "x" });
    expect(t).toMatchObject({ name: "x", kind: "command", enabled: true });
    expect(t?.stages).toEqual([]);
    expect(parseTool({ kind: "mcp" })).toBeNull();
    expect(parseTool(42)).toBeNull();
  });

  it("respects enabled:false and unknown kind falls back to command", () => {
    expect(parseTool({ name: "x", enabled: false })?.enabled).toBe(false);
    expect(parseTool({ name: "x", kind: "weird" })?.kind).toBe("command");
  });
});

describe("readTools / readToolConfig", () => {
  it("absent dir → [] and absent config → no overrides", () => {
    rmSync(join(work, ".otto", "tools"), { recursive: true, force: true });
    expect(readTools(work)).toEqual([]);
    expect(readToolConfig(work)).toEqual({ overrides: {} });
  });

  it("reads *.json sorted, skipping malformed", () => {
    writeTool("zeta", { name: "zeta", kind: "http" });
    writeTool("alpha", { name: "alpha" });
    writeFileSync(join(work, ".otto", "tools", "broken.json"), "{ nope");
    expect(readTools(work).map((t) => t.name)).toEqual(["alpha", "zeta"]);
  });

  it("reads only the tools block of config.json", () => {
    writeFileSync(
      join(work, ".otto", "config.json"),
      JSON.stringify({
        journal: { enabled: true },
        tools: { headroom: { enabled: false, stages: ["plan"] } },
      })
    );
    expect(readToolConfig(work).overrides.headroom).toEqual({
      enabled: false,
      stages: ["plan"],
    });
  });
});

describe("toolEnabledForStage / selectToolsForStage", () => {
  it("requires an explicit stage allowlist (opt-in)", () => {
    expect(
      toolEnabledForStage(tool({ stages: [] }), noOverrides, "review").enabled
    ).toBe(false);
    expect(
      toolEnabledForStage(tool({ stages: ["review"] }), noOverrides, "review")
        .enabled
    ).toBe(true);
    expect(
      toolEnabledForStage(tool({ stages: ["plan"] }), noOverrides, "review")
        .enabled
    ).toBe(false);
  });

  it("config override can disable or re-scope a tool", () => {
    const cfg: ToolConfig = { overrides: { headroom: { enabled: false } } };
    expect(toolEnabledForStage(tool(), cfg, "review").enabled).toBe(false);
    const rescope: ToolConfig = {
      overrides: { headroom: { stages: ["plan"] } },
    };
    expect(toolEnabledForStage(tool(), rescope, "plan").enabled).toBe(true);
    expect(toolEnabledForStage(tool(), rescope, "review").enabled).toBe(false);
  });

  it("selection sorts enabled-first then name, keeping disabled visible", () => {
    const sel = selectToolsForStage(
      [
        tool({ name: "b-on", stages: ["review"] }),
        tool({ name: "a-off", stages: ["plan"] }),
      ],
      noOverrides,
      "review"
    );
    expect(sel.map((s) => [s.name, s.enabled])).toEqual([
      ["b-on", true],
      ["a-off", false],
    ]);
  });
});

describe("authorizeToolInvocation", () => {
  it("allows everything under DEFAULT_POLICY when the tool declares scope", () => {
    const t = tool({ networkDomains: ["api.headroom.ai"], writeRoots: ["."] });
    const a = authorizeToolInvocation(DEFAULT_POLICY, t, {
      command: "headroom compress",
      domains: ["api.headroom.ai"],
      writePaths: ["src/x.ts"],
    });
    expect(a.allowed).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("blocks a domain the tool did not declare (empty list = no network)", () => {
    const a = authorizeToolInvocation(DEFAULT_POLICY, tool(), {
      domains: ["evil.com"],
    });
    expect(a.allowed).toBe(false);
    expect(a.events[0]).toMatchObject({
      category: "policy-violation",
      kind: "network-domain",
      blocked: true,
    });
  });

  it("enforces the intersection of repo policy and tool scope", () => {
    const policy: SafetyPolicy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["headroom.ai"],
    };
    const t = tool({ networkDomains: ["api.headroom.ai", "other.com"] });
    // headroom.ai subdomain: allowed by both
    expect(
      authorizeToolInvocation(policy, t, { domains: ["api.headroom.ai"] })
        .allowed
    ).toBe(true);
    // other.com: in tool scope but forbidden by repo policy
    expect(
      authorizeToolInvocation(policy, t, { domains: ["other.com"] }).allowed
    ).toBe(false);
  });

  it("blocks a blocked command and an approval-required action", () => {
    const policy: SafetyPolicy = {
      ...DEFAULT_POLICY,
      blockedCommands: ["rm -rf"],
      approvalRequiredActions: ["publish"],
    };
    expect(
      authorizeToolInvocation(policy, tool(), { command: "rm -rf /" }).allowed
    ).toBe(false);
    expect(
      authorizeToolInvocation(policy, tool(), { action: "publish" }).allowed
    ).toBe(false);
    expect(
      authorizeToolInvocation(
        DEFAULT_POLICY,
        tool({ approvalActions: ["deploy"] }),
        { action: "deploy" }
      ).allowed
    ).toBe(false);
  });

  it("blocks a write path outside the tool's declared roots", () => {
    const t = tool({ writeRoots: ["dist"] });
    expect(
      authorizeToolInvocation(DEFAULT_POLICY, t, { writePaths: ["src/x.ts"] })
        .allowed
    ).toBe(false);
    expect(
      authorizeToolInvocation(DEFAULT_POLICY, t, { writePaths: ["dist/x.js"] })
        .allowed
    ).toBe(true);
  });
});
