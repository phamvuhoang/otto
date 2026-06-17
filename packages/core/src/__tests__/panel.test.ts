import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runPanel } from "../panel.js";
import { emptyTokenUsage } from "../tokens.js";

const ok = (
  result: string,
  costUsd = 0,
  apiErrorStatus: string | null = null
) => ({
  result,
  costUsd,
  isError: apiErrorStatus != null,
  apiErrorStatus,
  usage: emptyTokenUsage(),
});
const noStop = () => ({ stop: false, cooldownFactor: 1 });

describe("runPanel", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-panel-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs each lens, then adversarial verify, then synth; reports each sub-agent, returns synth", async () => {
    mocks.executeStage.mockImplementation(
      (opts: {
        stage: { template: string };
        vars: { LENS?: string; FINDINGS_DIR?: string };
      }) => {
        if (opts.stage.template === "review-synth.md")
          return Promise.resolve(ok("<review>OK</review>", 0.5));
        if (opts.stage.template === "review-verify.md") {
          // The verifier satisfies its contract: it writes verdicts.md.
          writeFileSync(
            join(ws, opts.vars.FINDINGS_DIR!, "verdicts.md"),
            "REJECTED — a.ts:1 — nit — not a real defect\n",
            "utf8"
          );
          return Promise.resolve(
            ok("<verify>0 confirmed, 1 rejected</verify>", 0.2)
          );
        }
        return Promise.resolve(ok(`finding for ${opts.vars.LENS}`, 0.1));
      }
    );
    const seen: number[] = [];
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: (sr) => {
        seen.push(sr.costUsd);
        return noStop();
      },
    });
    expect(mocks.executeStage).toHaveBeenCalledTimes(5); // 3 lenses + verify + synth
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).toEqual([
      "review-lens.md",
      "review-lens.md",
      "review-lens.md",
      "review-verify.md",
      "review-synth.md",
    ]);
    // verify + synth read the same findings dir the lenses wrote to.
    const verifyCall = mocks.executeStage.mock.calls.find(
      (c: [{ stage: { template: string } }]) =>
        c[0].stage.template === "review-verify.md"
    )!;
    const synthCall = mocks.executeStage.mock.calls.find(
      (c: [{ stage: { template: string } }]) =>
        c[0].stage.template === "review-synth.md"
    )!;
    expect(verifyCall[0].vars.FINDINGS_DIR).toBe(
      synthCall[0].vars.FINDINGS_DIR
    );
    expect(mocks.sleep).toHaveBeenCalledTimes(4); // cooldown after each lens + after verify
    // onStage called for every sub-agent (3 lenses + verify + synth)
    expect(seen).toEqual([0.1, 0.1, 0.1, 0.2, 0.5]);
    expect(out.result).toBe("<review>OK</review>");
  });

  it("stops before remaining lenses + synth when onStage signals the budget is spent", async () => {
    mocks.executeStage.mockResolvedValue(ok("finding", 0.4));
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: () => ({ stop: true, cooldownFactor: 1 }), // budget hit after lens 1
    });
    expect(mocks.executeStage).toHaveBeenCalledTimes(1); // no further lenses, no synth
    expect(mocks.sleep).not.toHaveBeenCalled(); // stopped before the cooldown
    expect(out.result).toBe("finding");
  });

  it("stops before synth when the budget is spent during adversarial verify", async () => {
    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string } }) =>
        Promise.resolve(
          ok(
            opts.stage.template === "review-verify.md" ? "verdicts" : "finding",
            0.4
          )
        )
    );
    const out = await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      // budget survives the single lens but trips on the verify sub-agent.
      onStage: (sr) => ({ stop: sr.result === "verdicts", cooldownFactor: 1 }),
    });
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).toEqual(["review-lens.md", "review-verify.md"]); // no synth
    expect(out.result).toBe("verdicts");
  });

  it("skips synth when the verifier writes no verdicts.md (contract violation)", async () => {
    // No verify mock writes verdicts.md → the contract is unmet.
    mocks.executeStage.mockResolvedValue(ok("finding"));
    const out = await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).toEqual(["review-lens.md", "review-verify.md"]); // synth skipped
    expect(out.result).toBe("finding"); // returns the verify result, not a synth result
    const err = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(err).toContain("no validated verdicts");
  });

  it("reports a dirty worktree when synth edits but does not commit", async () => {
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: ws,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    g("init", "-q");
    writeFileSync(join(ws, ".gitignore"), ".otto-tmp/\n");
    writeFileSync(join(ws, "f.txt"), "orig\n");
    g("add", ".gitignore", "f.txt");
    g(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "impl"
    );

    mocks.executeStage.mockImplementation(
      (opts: {
        stage: { template: string };
        vars: { FINDINGS_DIR?: string };
      }) => {
        if (opts.stage.template === "review-verify.md")
          writeFileSync(
            join(ws, opts.vars.FINDINGS_DIR!, "verdicts.md"),
            "CONFIRMED — f.txt:1 — bug — real\n",
            "utf8"
          );
        if (opts.stage.template === "review-synth.md")
          // synth edits a tracked file but never commits.
          writeFileSync(join(ws, "f.txt"), "half-applied fix\n", "utf8");
        return Promise.resolve(ok("finding"));
      }
    );

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });

    const err = (
      process.stderr.write as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(err).toContain("did not commit");
  });

  it("applies the adaptive cooldown factor from onStage to the inter-lens sleep", async () => {
    mocks.executeStage.mockResolvedValue(ok("finding", 0));
    await runPanel({
      lenses: ["correctness", "security"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onStage: () => ({ stop: false, cooldownFactor: 4 }), // throttled → ×4
    });
    expect(mocks.sleep).toHaveBeenCalledWith(4000, undefined);
  });

  it("enforces lens read-only: a lens that commits is reset back to the implementer's HEAD", async () => {
    // Real git repo so the panel's git guard runs for real.
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: ws,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    g("init", "-q");
    g(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "impl"
    );
    const baseHead = g("rev-parse", "HEAD").trim();

    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string } }) => {
        if (opts.stage.template === "review-lens.md") {
          // A misbehaving lens makes a commit despite the read-only contract.
          g(
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "sneaky"
          );
        }
        return Promise.resolve(ok("finding"));
      }
    );

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });

    // The sneaky lens commit was undone; HEAD is back at the implementer's commit.
    expect(g("rev-parse", "HEAD").trim()).toBe(baseHead);
  });

  it("does NOT discard pre-existing uncommitted tracked changes (enforcement off when dirty)", async () => {
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: ws,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    g("init", "-q");
    writeFileSync(join(ws, "f.txt"), "committed\n");
    g("add", "f.txt");
    g(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "impl"
    );
    // A pre-existing uncommitted tracked modification by the user.
    writeFileSync(join(ws, "f.txt"), "user edit in progress\n");

    // A well-behaved lens touches nothing.
    mocks.executeStage.mockResolvedValue(ok("finding"));

    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      onStage: noStop,
    });

    // The user's in-progress edit is intact — the guard did not reset --hard it away.
    expect(readFileSync(join(ws, "f.txt"), "utf8")).toBe(
      "user edit in progress\n"
    );
  });
});
