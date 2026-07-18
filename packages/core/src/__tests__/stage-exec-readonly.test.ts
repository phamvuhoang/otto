import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SafetyPolicy } from "../safety-policy.js";
import type { Stage } from "../stages.js";
import { emptyTokenUsage } from "../tokens.js";

// Mock the runner so NO child process is spawned: the focused test asserts what
// executeStage threads INTO runStage (child env identity, injected policy render).
const mocks = vi.hoisted(() => ({
  runStage: vi.fn(),
}));

vi.mock("../runner.js", () => ({
  runStage: mocks.runStage,
  getAgentRuntime: (id: string) => ({ id }),
  stageLogPath: (
    workspaceDir: string,
    iteration: number,
    stageName: string,
    runtimeId?: string
  ) =>
    `${workspaceDir}/.otto-tmp/logs/iter${iteration}-${stageName}${
      runtimeId ? `-${runtimeId}` : ""
    }.ndjson`,
}));

import { executeStage } from "../stage-exec.js";

const ok = {
  result: "done",
  costUsd: 0,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
  runtimeId: "claude" as const,
};

describe("executeStage read-only child env + injected policy (P32)", () => {
  let root: string;
  let workspaceDir: string;
  let packageDir: string;
  const reviewStage: Stage = {
    name: "pr-review",
    template: "pr-review.md",
    access: "read-only",
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otto-readonly-"));
    workspaceDir = join(root, "workspace");
    packageDir = join(root, "pkg");
    mkdirSync(join(packageDir, "templates"), { recursive: true });
    mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
    mocks.runStage.mockReset().mockResolvedValue(ok);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("threads the supplied childEnv unchanged into runStage", async () => {
    writeFileSync(
      join(packageDir, "templates", reviewStage.template),
      "review this\n",
      "utf8"
    );
    const childEnv = {
      ANTHROPIC_API_KEY: "model-key",
      GH_CONFIG_DIR: "/ws/.otto-tmp/pr-review/empty-gh-config",
    } as NodeJS.ProcessEnv;

    await executeStage({
      stage: reviewStage,
      vars: {},
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      childEnv,
    });

    // runStage(stage, prompt, ws, iteration, spillHostDir, logPathOverride, opts)
    const runOpts = mocks.runStage.mock.calls[0][6] as {
      childEnv?: NodeJS.ProcessEnv;
    };
    expect(runOpts.childEnv).toBe(childEnv);
  });

  it("uses an injected safetyPolicy verbatim to block a command at render", async () => {
    // Template contains a host-shell tag; the injected (trusted operator) policy
    // blocks it, so the command is skipped and neutralized WITHOUT reading any
    // contributor-modified .otto/policy.json from the PR head.
    writeFileSync(
      join(packageDir, "templates", reviewStage.template),
      "x=!`echo hi`\n",
      "utf8"
    );
    // A permissive on-disk policy that WOULD allow echo — proving the injected
    // policy is what actually governs the render.
    writeFileSync(
      join(workspaceDir, ".otto", "policy.json"),
      JSON.stringify({ blockedCommands: [] }),
      "utf8"
    );

    const injected: SafetyPolicy = {
      allowedWriteRoots: [],
      blockedCommands: ["echo"],
      allowedNetworkDomains: [],
      secretPatterns: [],
      highRiskGlobs: [],
      approvalRequiredActions: [],
    };

    const sr = await executeStage({
      stage: reviewStage,
      vars: {},
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      safetyPolicy: injected,
    });

    // Command skipped ⇒ neutralized to empty output.
    expect(mocks.runStage.mock.calls[0][1]).toBe("x=\n");
    expect(sr.safetyEvents).toEqual([
      {
        category: "policy-violation",
        kind: "blocked-command",
        subject: "echo hi",
        message: 'command matches blocked pattern "echo"',
        blocked: true,
      },
    ]);
  });

  it("still loads the workspace policy when none is injected", async () => {
    writeFileSync(
      join(packageDir, "templates", reviewStage.template),
      "x=!`echo hi`\n",
      "utf8"
    );
    writeFileSync(
      join(workspaceDir, ".otto", "policy.json"),
      JSON.stringify({ blockedCommands: ["echo"] }),
      "utf8"
    );

    const sr = await executeStage({
      stage: reviewStage,
      vars: {},
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
    });

    expect(mocks.runStage.mock.calls[0][1]).toBe("x=\n");
    expect(sr.safetyEvents?.[0]?.kind).toBe("blocked-command");
  });
});
