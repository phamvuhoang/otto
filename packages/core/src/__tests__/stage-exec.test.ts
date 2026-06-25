import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeContext } from "../context-report.js";
import type { Stage } from "../stages.js";
import { emptyTokenUsage } from "../tokens.js";

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

const stage: Stage = { name: "implementer", template: "stage.md" };
const ok = {
  result: "done",
  costUsd: 0,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
  runtimeId: "claude" as const,
};

describe("executeStage token mode", () => {
  let root: string;
  let workspaceDir: string;
  let packageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otto-stage-exec-"));
    workspaceDir = join(root, "workspace");
    packageDir = join(root, "pkg");
    mkdirSync(join(packageDir, "templates"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(packageDir, "templates", stage.template),
      "hello {{ INPUTS }}   \n\n\n\n\nread ./full.txt   \n",
      "utf8"
    );
    mocks.runStage.mockReset().mockResolvedValue(ok);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not change the rendered prompt in off mode", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "off",
    });
    expect(mocks.runStage.mock.calls[0][1]).toBe(
      "hello plan   \n\n\n\n\nread ./full.txt   \n"
    );
  });

  it("appends injectedContext to the rendered prompt (P18 skills)", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      injectedContext: "<available-skills>tdd guidance</available-skills>",
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "off",
    });
    const prompt = mocks.runStage.mock.calls[0][1] as string;
    expect(prompt).toContain("hello plan");
    expect(prompt).toContain(
      "<available-skills>tdd guidance</available-skills>"
    );
  });

  it("leaves the prompt unchanged when injectedContext is empty", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      injectedContext: "",
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "off",
    });
    expect(mocks.runStage.mock.calls[0][1]).toBe(
      "hello plan   \n\n\n\n\nread ./full.txt   \n"
    );
  });

  it("does not change the rendered prompt in measure mode", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "measure",
    });
    expect(mocks.runStage.mock.calls[0][1]).toBe(
      "hello plan   \n\n\n\n\nread ./full.txt   \n"
    );
  });

  it("compacts the rendered prompt in reduce mode", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "reduce",
    });
    expect(mocks.runStage.mock.calls[0][1]).toBe(
      "hello plan\n\n\nread ./full.txt\n"
    );
  });

  it("attaches a context breakdown of the final rendered prompt", async () => {
    writeFileSync(
      join(packageDir, "templates", stage.template),
      "playbook prose\n<learnings>durable notes</learnings>\n{{ INPUTS }}\n",
      "utf8"
    );
    const sr = await executeStage({
      stage,
      vars: { INPUTS: "<inputs>the task</inputs>" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
    });
    const prompt = mocks.runStage.mock.calls[0][1] as string;
    // Reflects exactly what was sent to runStage, attributed by category.
    expect(sr.contextBreakdown).toEqual(analyzeContext(prompt));
    const cats = sr.contextBreakdown!.segments.map((s) => s.category);
    expect(cats).toContain("learnings");
    expect(cats).toContain("inputs");
    expect(cats).toContain("playbook");
  });

  it("breaks down the post-reduction prompt in reduce mode", async () => {
    const sr = await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      tokenMode: "reduce",
    });
    const sentPrompt = mocks.runStage.mock.calls[0][1] as string;
    expect(sr.contextBreakdown!.totalChars).toBe(sentPrompt.length);
  });

  it("forwards the injected sink to runStage", async () => {
    const sink = { setStage: vi.fn(), onEvent: vi.fn() };
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
      sink,
    });
    const runOpts = mocks.runStage.mock.calls[0][6] as { sink?: unknown };
    expect(runOpts.sink).toBe(sink);
  });

  it("threads agentId into the stage log filename", async () => {
    await executeStage({
      stage,
      vars: { INPUTS: "plan" },
      workspaceDir,
      packageDir,
      iteration: 3,
      maxRetries: 0,
      agentId: "codex",
    });
    // runStage(stage, prompt, ws, iteration, spillHostDir, logPathOverride, opts)
    expect(mocks.runStage.mock.calls[0][5]).toContain(
      "iter3-implementer-codex.ndjson"
    );
  });
});

describe("executeStage safety policy", () => {
  let root: string;
  let workspaceDir: string;
  let packageDir: string;
  const policyStage: Stage = { name: "implementer", template: "policy.md" };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otto-stage-policy-"));
    workspaceDir = join(root, "workspace");
    packageDir = join(root, "pkg");
    mkdirSync(join(packageDir, "templates"), { recursive: true });
    mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
    writeFileSync(
      join(packageDir, "templates", policyStage.template),
      "x=!`echo hi`\n",
      "utf8"
    );
    mocks.runStage.mockReset().mockResolvedValue(ok);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("emits no safety events under an absent policy", async () => {
    const sr = await executeStage({
      stage: policyStage,
      vars: {},
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
    });
    expect(sr.safetyEvents).toBeUndefined();
    expect(mocks.runStage.mock.calls[0][1]).toBe("x=hi\n");
  });

  it("records a blocked policy-violation safety event for a denied command", async () => {
    writeFileSync(
      join(workspaceDir, ".otto", "policy.json"),
      JSON.stringify({ blockedCommands: ["echo"] }),
      "utf8"
    );
    const sr = await executeStage({
      stage: policyStage,
      vars: {},
      workspaceDir,
      packageDir,
      iteration: 1,
      maxRetries: 0,
    });
    expect(mocks.runStage.mock.calls[0][1]).toBe("x=\n"); // command skipped
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
});
