import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditToolPolicyConflicts,
  auditTools,
  runTools,
  type ToolsDeps,
} from "../tools-cli.js";
import { DEFAULT_POLICY, type SafetyPolicy } from "../safety-policy.js";
import type { ToolConfig, ToolDefinition } from "../tools.js";

let work: string;
let out: string[];
let err: string[];

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "headroom",
    kind: "command",
    capabilities: [],
    stages: ["review"],
    env: [],
    networkDomains: [],
    writeRoots: [],
    secretRefs: [],
    approvalActions: [],
    enabled: true,
    healthCheck: "true",
    ...overrides,
  };
}

function deps(health?: ToolsDeps["health"]): ToolsDeps {
  return {
    env: { OTTO_WORKSPACE: work },
    cwd: work,
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    health: health ?? (() => Promise.resolve({ ok: true, detail: "ok" })),
  };
}

function writeTool(name: string, def: Record<string, unknown>): void {
  writeFileSync(
    join(work, ".otto", "tools", `${name}.json`),
    JSON.stringify(def)
  );
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "otto-tools-cli-"));
  mkdirSync(join(work, ".otto", "tools"), { recursive: true });
  out = [];
  err = [];
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("auditTools", () => {
  const noOv: ToolConfig = { overrides: {} };

  it("flags enabled-but-unreachable and missing health check", () => {
    const findings = auditTools(
      [tool({ stages: [], healthCheck: undefined })],
      noOv
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "no-health-check",
      "unreachable",
    ]);
  });

  it("does not flag an sdk tool for a missing health check", () => {
    const findings = auditTools(
      [tool({ kind: "sdk", healthCheck: undefined })],
      noOv
    );
    expect(findings.some((f) => f.kind === "no-health-check")).toBe(false);
  });
});

describe("auditToolPolicyConflicts", () => {
  it("flags a declared domain the repo policy forbids", () => {
    const policy: SafetyPolicy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["good.com"],
    };
    const findings = auditToolPolicyConflicts(
      [tool({ networkDomains: ["bad.com"] })],
      policy
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("policy-conflict");
  });

  it("no conflicts under the permissive default policy", () => {
    expect(
      auditToolPolicyConflicts(
        [tool({ networkDomains: ["x.com"] })],
        DEFAULT_POLICY
      )
    ).toEqual([]);
  });
});

describe("runTools", () => {
  it("list shows empty-state when no tools", async () => {
    expect(await runTools(["list"], deps())).toBe(0);
    expect(out.join("\n")).toContain("No tools");
  });

  it("list shows enabled state and stages", async () => {
    writeTool("headroom", {
      name: "headroom",
      kind: "command",
      stages: ["review"],
      capabilities: ["compression"],
    });
    await runTools(["list"], deps());
    expect(out.join("\n")).toContain(
      "headroom  [command]  enabled  stages: review"
    );
  });

  it("why explains stage availability", async () => {
    writeTool("headroom", { name: "headroom", stages: ["review"] });
    await runTools(["why", "review"], deps());
    expect(out.join("\n")).toContain("[available]");
    out.length = 0;
    await runTools(["why", "plan"], deps());
    expect(out.join("\n")).toContain("[skip]");
  });

  it("audit returns exit 1 with findings", async () => {
    writeTool("bad", { name: "bad", enabled: true, stages: [] });
    expect(await runTools(["audit"], deps())).toBe(1);
    expect(out.join("\n")).toContain("unreachable");
  });

  it("audit returns exit 0 when clean", async () => {
    writeTool("ok", { name: "ok", stages: ["review"], healthCheck: "true" });
    expect(await runTools(["audit"], deps())).toBe(0);
    expect(out.join("\n")).toContain("clean");
  });

  it("health runs the injected probe and reflects failure in the exit code", async () => {
    writeTool("up", { name: "up", stages: ["review"], healthCheck: "true" });
    writeTool("down", {
      name: "down",
      stages: ["review"],
      healthCheck: "false",
    });
    const code = await runTools(
      ["health"],
      deps((t) =>
        Promise.resolve({
          ok: t.name === "up",
          detail: t.name === "up" ? "ok" : "exit 1",
        })
      )
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("ok   up");
    expect(out.join("\n")).toContain("FAIL down");
  });

  it("rejects an unknown subcommand", async () => {
    expect(await runTools(["frobnicate"], deps())).toBe(1);
    expect(err.join("\n")).toContain("Unknown subcommand");
  });
});
