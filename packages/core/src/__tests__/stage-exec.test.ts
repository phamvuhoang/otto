import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "../stages.js";
import { emptyTokenUsage } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  runStage: vi.fn(),
}));

vi.mock("../runner.js", () => ({
  runStage: mocks.runStage,
  stageLogPath: (workspaceDir: string, iteration: number, stageName: string) =>
    `${workspaceDir}/.otto-tmp/logs/iter${iteration}-${stageName}.ndjson`,
}));

import { executeStage } from "../stage-exec.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const ok = {
  result: "done",
  costUsd: 0,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
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
});
