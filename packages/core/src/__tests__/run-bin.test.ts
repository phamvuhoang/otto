import { afterEach, describe, expect, it, vi } from "vitest";

import { runBin, type RunBinConfig } from "../run-bin.js";
import type { Stage } from "../stages.js";

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
