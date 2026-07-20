import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { analyzeReview, ReviewAnalysisContractError } from "../panel.js";
import { emptyTokenUsage } from "../tokens.js";

const ok = (result: string, costUsd = 0, isError = false) => ({
  result,
  costUsd,
  isError,
  apiErrorStatus: isError ? "500" : null,
  usage: emptyTokenUsage(),
});
const noStop = () => ({ stop: false, cooldownFactor: 1 });

// A verifier wire result confirming one candidate row (pipe format).
const confirmVerify = (rows: string[]) =>
  ok(rows.join("\n") + "\n<verify>done</verify>", 0.2);

describe("analyzeReview", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-analysis-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  const base = {
    workspaceDir: "",
    packageDir: "/pkg",
    iteration: 1,
    maxRetries: 0,
    cooldownMs: 0,
    onStage: noStop,
  };

  it("runs lenses bounded-concurrent and records results in configured order", async () => {
    let active = 0;
    let peak = 0;
    mocks.executeStage.mockImplementation(
      async (o: { vars: { LENS?: string } }) => {
        if (o.vars.LENS) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return ok(`major | a.ts:1 | bug in ${o.vars.LENS} | why`, 0.1);
        }
        return confirmVerify([
          "CONFIRMED major | a.ts:1 | bug in l1 | why",
          "CONFIRMED major | a.ts:1 | bug in l2 | why",
          "CONFIRMED major | a.ts:1 | bug in l3 | why",
          "CONFIRMED major | a.ts:1 | bug in l4 | why",
          "CONFIRMED major | a.ts:1 | bug in l5 | why",
        ]);
      }
    );
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1", "l2", "l3", "l4", "l5"],
    });
    expect(peak).toBeLessThanOrEqual(4); // LENS_CONCURRENCY
    // Merged/deduped: 5 lenses, distinct claims → 5 confirmed.
    expect(res.confirmed).toHaveLength(5);
    // stageResults preserve lens order then verify.
    const lensResults = res.stageResults.slice(0, 5).map((s) => s.result);
    expect(lensResults).toEqual([
      "major | a.ts:1 | bug in l1 | why",
      "major | a.ts:1 | bug in l2 | why",
      "major | a.ts:1 | bug in l3 | why",
      "major | a.ts:1 | bug in l4 | why",
      "major | a.ts:1 | bug in l5 | why",
    ]);
  });

  it("dedupes identical findings across lenses before verify", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | same bug | why", 0.1));
      return Promise.resolve(
        confirmVerify(["CONFIRMED major | a.ts:1 | same bug | why"])
      );
    });
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1", "l2", "l3"],
    });
    expect(res.confirmed).toHaveLength(1); // deduped to one candidate
  });

  it("verdictSource:result parses the verifier result and never needs verdicts.md", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | real bug | why", 0.1));
      return Promise.resolve(
        confirmVerify([
          "CONFIRMED major | a.ts:1 | real bug | verified against diff",
        ])
      );
    });
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1"],
    });
    expect(res.confirmed).toHaveLength(1);
    expect(res.severity.major).toBe(1);
    expect(res.contractErrors).toEqual([]);
  });

  it("skips verify and returns a clean analysis with zero candidate findings", async () => {
    mocks.executeStage.mockResolvedValue(ok("none", 0.1)); // lens finds nothing
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1", "l2"],
    });
    // Only the two lenses ran — no verify.
    expect(mocks.executeStage).toHaveBeenCalledTimes(2);
    expect(res.confirmed).toEqual([]);
    expect(res.stageResults).toHaveLength(2);
    expect(res.contractErrors).toEqual([]);
  });

  it("throws a ReviewAnalysisContractError on missing/malformed verdicts", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | real bug | why", 0.1));
      // Verifier omits a verdict for the candidate → contract violation.
      return Promise.resolve(ok("none\n", 0.2));
    });
    await expect(
      analyzeReview({
        ...base,
        workspaceDir: ws,
        verdictSource: "result",
        lenses: ["l1"],
      })
    ).rejects.toBeInstanceOf(ReviewAnalysisContractError);
  });

  it("counts confirmed nits but suppresses them from confirmed when a major survives", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS === "a")
        return Promise.resolve(ok("major | a.ts:1 | big | why", 0.1));
      if (o.vars.LENS === "b")
        return Promise.resolve(ok("nit | a.ts:9 | small | why", 0.1));
      return Promise.resolve(
        confirmVerify([
          "CONFIRMED major | a.ts:1 | big | real",
          "CONFIRMED nit | a.ts:9 | small | real",
        ])
      );
    });
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["a", "b"],
    });
    expect(res.severity.major).toBe(1);
    expect(res.severity.nit).toBe(1); // counted before suppression
    expect(res.severity.suppressed).toBe(1);
    expect(res.confirmed.map((f) => f.severity)).toEqual(["major"]); // nit dropped
  });

  it("turns a mutation into a contract error under mutationPolicy:fail", async () => {
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
    mocks.executeStage.mockImplementation(
      (o: { stage: { template: string } }) => {
        if (o.stage.template === "review-lens.md") {
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
        return Promise.resolve(ok("major | a.ts:1 | bug | why", 0.1));
      }
    );
    await expect(
      analyzeReview({
        ...base,
        workspaceDir: ws,
        verdictSource: "result",
        mutationPolicy: "fail",
        lenses: ["l1"],
      })
    ).rejects.toBeInstanceOf(ReviewAnalysisContractError);
  });

  it("threads stageVars, childEnv, sink, safetyPolicy into every stage and merges skill/taint into results", async () => {
    const sink = { emit: () => {} } as never;
    const childEnv = { OTTO_X: "1" } as NodeJS.ProcessEnv;
    const safetyPolicy = { version: 1 } as never;
    const skillUsages = [{ name: "s", version: "1" }];
    const inputSafetyEvents = [
      {
        category: "taint" as const,
        kind: "issue-body" as never,
        subject: "x",
        message: "m",
        blocked: false,
      },
    ];
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | bug | why", 0.1));
      return Promise.resolve(
        confirmVerify(["CONFIRMED major | a.ts:1 | bug | real"])
      );
    });
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1"],
      stageVars: { REPO_INSTRUCTIONS_PATH: "/trusted/AGENTS.md" },
      childEnv,
      sink,
      safetyPolicy,
      skillUsages,
      inputSafetyEvents,
    });
    for (const call of mocks.executeStage.mock.calls) {
      const o = call[0];
      expect(o.vars.REPO_INSTRUCTIONS_PATH).toBe("/trusted/AGENTS.md");
      expect(o.childEnv).toBe(childEnv);
      expect(o.sink).toBe(sink);
      expect(o.safetyPolicy).toBe(safetyPolicy);
    }
    // skill usage + input taint merged into every returned StageResult.
    for (const sr of res.stageResults) {
      expect(sr.skillsUsed).toEqual(skillUsages);
      expect(sr.safetyEvents).toEqual(inputSafetyEvents);
    }
  });

  it("never invokes review-synth.md", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | bug | why", 0.1));
      return Promise.resolve(
        confirmVerify(["CONFIRMED major | a.ts:1 | bug | real"])
      );
    });
    await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      lenses: ["l1"],
    });
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).not.toContain("review-synth.md");
  });

  it("fails analysis when a lens StageResult.isError is set", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(ok("major | a.ts:1 | bug | why", 0.1, true)); // isError
      return Promise.resolve(
        confirmVerify(["CONFIRMED major | a.ts:1 | bug | real"])
      );
    });
    await expect(
      analyzeReview({
        ...base,
        workspaceDir: ws,
        verdictSource: "result",
        lenses: ["l1"],
      })
    ).rejects.toBeInstanceOf(ReviewAnalysisContractError);
  });

  it("strictFindings fails on a malformed finding row that panel mode would drop", async () => {
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        // "major | a.ts | half" → a real severity but a TRUNCATED row (<4 fields):
        // a genuinely botched finding, which strict mode must fail on.
        return Promise.resolve(ok("major | a.ts | half", 0.1));
      return Promise.resolve(ok("none\n", 0.2));
    });
    await expect(
      analyzeReview({
        ...base,
        workspaceDir: ws,
        verdictSource: "result",
        strictFindings: true,
        lenses: ["l1"],
      })
    ).rejects.toBeInstanceOf(ReviewAnalysisContractError);
  });

  it("strictFindings does NOT fail when a lens emits a pipe-bearing prose line", async () => {
    // Regression: a lens emitted a real finding plus narration containing a pipe
    // ("reduces to `a | b`"). The pipe line is NOT a finding attempt (its first
    // field is not a severity), so it must not be counted as a malformed row and
    // fail the whole strict review.
    mocks.executeStage.mockImplementation((o: { vars: { LENS?: string } }) => {
      if (o.vars.LENS)
        return Promise.resolve(
          ok(
            "major | a.ts:1 | real bug | the guard reduces to `a | b`\n" +
              "It short-circuits when `a | b` is truthy.\n",
            0.1
          )
        );
      // Verifier confirms the single finding so the run completes cleanly.
      return Promise.resolve(
        ok("CONFIRMED major | a.ts:1 | real bug | confirmed\n", 0.2)
      );
    });
    const res = await analyzeReview({
      ...base,
      workspaceDir: ws,
      verdictSource: "result",
      strictFindings: true,
      lenses: ["l1"],
    });
    expect(res.contractErrors).toEqual([]);
    expect(res.confirmed).toHaveLength(1);
  });
});
