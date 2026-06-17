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

describe("runBin agent runtime", () => {
  const oldAgent = process.env.OTTO_AGENT;

  afterEach(() => {
    vi.restoreAllMocks();
    if (oldAgent === undefined) delete process.env.OTTO_AGENT;
    else process.env.OTTO_AGENT = oldAgent;
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
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => {
        throw new Error("exit");
      }) as any);

    await expect(runBin(["plan", "1"], cfg)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.join("")).toContain("OTTO_AGENT must be one of claude|codex");
  });

  it("fails a real run when the selected runtime is not yet implemented", async () => {
    delete process.env.OTTO_AGENT;
    captureStdout();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
      errs.push(a.join(" "));
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => {
        throw new Error("exit");
      }) as any);

    await expect(runBin(["--agent", "codex", "plan", "1"], cfg)).rejects.toThrow(
      "exit"
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.join("")).toContain("Codex CLI");
  });
});
