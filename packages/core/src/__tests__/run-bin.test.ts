import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyTokenUsage } from "../tokens.js";
import { runBin, type RunBinConfig } from "../run-bin.js";
import { writeStageRecord, type StageRecord } from "../run-report.js";
import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  runLoop: vi.fn(),
  resolveBranch: vi.fn(),
  ensureTmpIgnored: vi.fn(),
  resolveSubIssueList: vi.fn(),
}));

vi.mock("../loop.js", () => ({
  runLoop: mocks.runLoop,
}));

vi.mock("../gh-sub-issues.js", () => ({
  resolveSubIssueList: mocks.resolveSubIssueList,
}));

vi.mock("../branch.js", () => ({
  dirtyTreeWarning: () => null,
  ensureTmpIgnored: mocks.ensureTmpIgnored,
  resolveBranch: mocks.resolveBranch,
}));

const stage: Stage = { name: "implementer", template: "stage.md" };

const cfg: RunBinConfig = {
  bin: "otto-afk",
  usage: "<plan-and-prd> <iterations>",
  desc: "plan/PRD-driven Claude Code AFK loop",
  stages: [stage],
  takesInputArg: true,
  mode: "afk",
};

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    chunks.push(String(s));
    return true;
  });
  return chunks;
}

function mockLoopSuccess() {
  mocks.runLoop.mockResolvedValue({
    costUsd: 0,
    sentinelHit: false,
    tokenUsage: emptyTokenUsage(),
  });
}

function mockBranch(workspaceDir: string) {
  mocks.resolveBranch.mockResolvedValue({
    strategy: "current",
    effectiveWorkspaceDir: workspaceDir,
    summaryLine: "branch: current",
  });
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "otto-run-bin-"));
}

beforeEach(() => {
  mocks.runLoop.mockReset();
  mocks.resolveBranch.mockReset();
  mocks.ensureTmpIgnored.mockReset();
  mockLoopSuccess();
});

describe("runBin token mode diagnostics", () => {
  const oldTokenMode = process.env.OTTO_TOKEN_MODE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (oldTokenMode === undefined) delete process.env.OTTO_TOKEN_MODE;
    else process.env.OTTO_TOKEN_MODE = oldTokenMode;
  });

  it("reports invalid OTTO_TOKEN_MODE in --print-config without throwing", async () => {
    process.env.OTTO_TOKEN_MODE = "aggressive";
    const stdout = captureStdout();

    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();

    const text = stdout.join("");
    expect(text).toContain("token mode            invalid (aggressive;");
    expect(text).toContain("OTTO_TOKEN_MODE must be one of");
  });
});

describe("runBin agent runtime", () => {
  const oldAgent = process.env.OTTO_AGENT;
  const oldWorkspace = process.env.OTTO_WORKSPACE;
  let workspace: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (oldAgent === undefined) delete process.env.OTTO_AGENT;
    else process.env.OTTO_AGENT = oldAgent;
    if (oldWorkspace === undefined) delete process.env.OTTO_WORKSPACE;
    else process.env.OTTO_WORKSPACE = oldWorkspace;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("defaults the runtime to claude in --print-config", async () => {
    delete process.env.OTTO_AGENT;
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    const text = stdout.join("");
    expect(text).toContain("runtime               claude (Claude Code)");
    expect(text).toContain("runtime source        default");
  });

  it("shows OTTO_AGENT selection and source in --print-config", async () => {
    process.env.OTTO_AGENT = "codex";
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    const text = stdout.join("");
    expect(text).toContain("runtime               codex (Codex CLI)");
    expect(text).toContain("runtime source        env");
  });

  it("reports invalid OTTO_AGENT in --print-config without throwing", async () => {
    process.env.OTTO_AGENT = "gpt";
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    const text = stdout.join("");
    expect(text).toContain("runtime               invalid (");
    expect(text).toContain("OTTO_AGENT must be one of claude|codex");
  });

  it("fails a real run when OTTO_AGENT is invalid (no silent claude fallback)", async () => {
    process.env.OTTO_AGENT = "gpt";
    captureStdout();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
      errs.push(a.join(" "));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as any);

    await expect(runBin(["plan", "1"], cfg)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.join("")).toContain("OTTO_AGENT must be one of claude|codex");
  });

  it("passes codex selection into a real run", async () => {
    delete process.env.OTTO_AGENT;
    workspace = makeWorkspace();
    process.env.OTTO_WORKSPACE = workspace;
    mockBranch(workspace);
    captureStdout();

    await expect(
      runBin(["--agent", "codex", "plan", "1"], cfg)
    ).resolves.toBeUndefined();

    expect(mocks.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        agentDisplayName: "Codex CLI",
      })
    );
  });
});

describe("runBin fallback runtime", () => {
  const oldFallback = process.env.OTTO_FALLBACK_AGENT;
  const oldSwitch = process.env.OTTO_AUTO_SWITCH_ON_LIMIT;
  const oldAgent = process.env.OTTO_AGENT;
  const oldWorkspace = process.env.OTTO_WORKSPACE;
  let workspace: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("OTTO_FALLBACK_AGENT", oldFallback);
    restore("OTTO_AUTO_SWITCH_ON_LIMIT", oldSwitch);
    restore("OTTO_AGENT", oldAgent);
    restore("OTTO_WORKSPACE", oldWorkspace);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("shows OTTO_FALLBACK_AGENT + auto-switch in --print-config", async () => {
    process.env.OTTO_FALLBACK_AGENT = "codex";
    process.env.OTTO_AUTO_SWITCH_ON_LIMIT = "1";
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    const text = stdout.join("");
    expect(text).toContain(
      "fallback              codex (Codex CLI, env) · auto-switch on"
    );
  });

  it("defaults fallback to off in --print-config", async () => {
    delete process.env.OTTO_FALLBACK_AGENT;
    delete process.env.OTTO_AUTO_SWITCH_ON_LIMIT;
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    expect(stdout.join("")).toContain("fallback              off");
  });

  it("reports invalid OTTO_FALLBACK_AGENT in --print-config without throwing", async () => {
    process.env.OTTO_FALLBACK_AGENT = "gpt";
    const stdout = captureStdout();
    await expect(runBin(["--print-config"], cfg)).resolves.toBeUndefined();
    const text = stdout.join("");
    expect(text).toContain("fallback              invalid (");
    expect(text).toContain("OTTO_FALLBACK_AGENT must be one of claude|codex");
  });

  it("fails a real run when OTTO_FALLBACK_AGENT is invalid", async () => {
    delete process.env.OTTO_AGENT;
    process.env.OTTO_FALLBACK_AGENT = "gpt";
    captureStdout();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
      errs.push(a.join(" "));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as any);

    await expect(runBin(["plan", "1"], cfg)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.join("")).toContain(
      "OTTO_FALLBACK_AGENT must be one of claude|codex"
    );
  });

  it("allows auto-switch to codex now that the fallback adapter exists", async () => {
    delete process.env.OTTO_AGENT;
    process.env.OTTO_FALLBACK_AGENT = "codex";
    process.env.OTTO_AUTO_SWITCH_ON_LIMIT = "1";
    workspace = makeWorkspace();
    process.env.OTTO_WORKSPACE = workspace;
    mockBranch(workspace);
    captureStdout();

    await expect(runBin(["plan", "1"], cfg)).resolves.toBeUndefined();
    expect(mocks.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "claude",
        fallbackAgentId: "codex",
        fallbackAgentDisplayName: "Codex CLI",
        autoSwitchOnLimit: true,
      })
    );
  });
});

describe("runBin --include-sub-issues", () => {
  const ghafkCfg: RunBinConfig = {
    bin: "otto-ghafk",
    usage: "<iterations>",
    desc: "gh",
    stages: [{ name: "ghafk-implementer", template: "ghafk.md" }],
    takesInputArg: false,
    mode: "ghafk",
    supportsWatch: true,
    supportsRepoScope: true,
    issueStage: { name: "ghafk-issue-implementer", template: "ghafk-issue.md" },
  };
  const oldWorkspace = process.env.OTTO_WORKSPACE;
  let workspace: string | undefined;

  beforeEach(() => {
    mocks.resolveSubIssueList.mockReset();
    mocks.resolveSubIssueList.mockReturnValue([40, 41, 42]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
    if (oldWorkspace === undefined) delete process.env.OTTO_WORKSPACE;
    else process.env.OTTO_WORKSPACE = oldWorkspace;
    delete process.env.OTTO_ISSUE;
    delete process.env.OTTO_INCLUDE_SUB_ISSUES;
  });

  it("runs runLoop once per resolved sub-issue with that issue's number", async () => {
    workspace = makeWorkspace();
    process.env.OTTO_WORKSPACE = workspace;
    mockBranch(workspace);
    captureStdout();

    await expect(
      runBin(["--issue", "38", "--include-sub-issues", "2"], ghafkCfg)
    ).resolves.toBeUndefined();

    expect(mocks.runLoop).toHaveBeenCalledTimes(3);
    expect(mocks.runLoop.mock.calls.map((c) => c[0].inputs)).toEqual([
      "40",
      "41",
      "42",
    ]);
  });

  it("errors when --include-sub-issues is used without --issue", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBin(["--include-sub-issues", "2"], ghafkCfg).catch(() => {});

    expect(err).toHaveBeenCalledWith("--include-sub-issues requires --issue");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("runBin --context-report", () => {
  const oldWorkspace = process.env.OTTO_WORKSPACE;
  let workspace: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
    if (oldWorkspace === undefined) delete process.env.OTTO_WORKSPACE;
    else process.env.OTTO_WORKSPACE = oldWorkspace;
  });

  function record(): StageRecord {
    return {
      iteration: 1,
      stage: "implementer",
      runtimeId: "claude",
      costUsd: 0,
      usage: emptyTokenUsage(),
      isError: false,
      apiErrorStatus: null,
      contextBreakdown: {
        totalChars: 400,
        estimatedTokens: 100,
        segments: [{ category: "playbook", chars: 400, estimatedTokens: 100 }],
      },
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:00:01.000Z",
    };
  }

  it("propagates exit 1 when there is no run to report on", async () => {
    workspace = makeWorkspace();
    process.env.OTTO_WORKSPACE = workspace;
    captureStdout();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as any);

    await expect(runBin(["--context-report"], cfg)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 0 (does not call process.exit) when a run can be reported", async () => {
    workspace = makeWorkspace();
    process.env.OTTO_WORKSPACE = workspace;
    writeStageRecord(workspace, "2026-06-20T00-00-00-000Z-1", 0, record());
    captureStdout();
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as any);

    await expect(runBin(["--context-report"], cfg)).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
