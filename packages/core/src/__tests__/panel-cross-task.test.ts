import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { formatCrossTaskBlock, runPanel } from "../panel.js";
import { emptyTokenUsage } from "../tokens.js";

const ok = (result: string, costUsd = 0) => ({
  result,
  costUsd,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
});

describe("formatCrossTaskBlock", () => {
  it("wraps a non-empty summary in a bounded block", () => {
    const b = formatCrossTaskBlock(
      "Cross-task interactions:\n- t2 deferred: conflict"
    );
    expect(b).toContain("t2 deferred");
    expect(b.length).toBeGreaterThan(0);
  });
  it("empty when no summary", () => {
    expect(formatCrossTaskBlock(undefined)).toBe("");
    expect(formatCrossTaskBlock("")).toBe("");
  });
});

describe("runPanel — cross-task summary wiring", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-panel-xtask-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("injects the cross-task block into the lens and verify prompt vars", async () => {
    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string } }) =>
        Promise.resolve(
          ok(
            opts.stage.template === "review-verify.md"
              ? "verdicts"
              : "major | a.ts:1 | bug | why |"
          )
        )
    );

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      resumeNote: "Switch note",
      crossTaskSummary: "Cross-task interactions:\n- t2 deferred: conflict",
      // Stop right after verify so we don't need to satisfy the synth path.
      onStage: (sr) => ({ stop: sr.result === "verdicts", cooldownFactor: 1 }),
    });

    const calls = mocks.executeStage.mock.calls as {
      stage: { template: string };
      vars: { RESUME?: string };
    }[][];
    const lensCall = calls.find(
      (c) => c[0].stage.template === "review-lens.md"
    )!;
    const verifyCall = calls.find(
      (c) => c[0].stage.template === "review-verify.md"
    )!;
    expect(lensCall[0].vars.RESUME).toContain("t2 deferred: conflict");
    expect(lensCall[0].vars.RESUME).toContain("Switch note"); // resumeNote still present
    expect(verifyCall[0].vars.RESUME).toContain("t2 deferred: conflict");
  });

  it("leaves RESUME unchanged when no cross-task summary is given (inert)", async () => {
    mocks.executeStage.mockResolvedValue(ok("finding"));

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      resumeNote: "Switch note",
      onStage: () => ({ stop: true, cooldownFactor: 1 }),
    });

    expect(mocks.executeStage.mock.calls[0][0].vars.RESUME).toBe("Switch note");
  });

  it("forces the structural lens in when the summary flags an out-of-scope touch", async () => {
    mocks.executeStage.mockResolvedValue(ok("major | a.ts:1 | bug | why |"));

    await runPanel({
      lenses: ["correctness", "tests", "structural"],
      // Adaptive router on with a docs-only change would otherwise route the
      // medium subset (correctness/tests/task-fit), dropping structural.
      changedPaths: ["README.md"],
      adaptiveRouter: true,
      crossTaskSummary:
        "Cross-task interactions:\n- t1 touched out-of-scope: src/shared.ts",
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: () => ({ stop: true, cooldownFactor: 1 }),
    });

    const lenses = mocks.executeStage.mock.calls.map(
      (c: [{ vars: { LENS?: string } }]) => c[0].vars.LENS
    );
    expect(lenses).toContain("structural");
  });

  it("does not add structural when the summary has no out-of-scope mention", async () => {
    mocks.executeStage.mockResolvedValue(ok("major | a.ts:1 | bug | why |"));

    await runPanel({
      lenses: ["correctness", "tests", "structural"],
      changedPaths: ["README.md"],
      adaptiveRouter: true,
      crossTaskSummary: "Cross-task interactions:\n- t2 deferred: conflict",
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: () => ({ stop: true, cooldownFactor: 1 }),
    });

    const lenses = mocks.executeStage.mock.calls.map(
      (c: [{ vars: { LENS?: string } }]) => c[0].vars.LENS
    );
    expect(lenses).not.toContain("structural");
  });
});
