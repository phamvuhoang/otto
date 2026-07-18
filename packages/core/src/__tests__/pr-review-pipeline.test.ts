import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline tests inject a FAKE analyze via deps, so real executeStage is
// never called there. The dedicated "renders real templates" test calls the
// REAL analyzeReview, which uses this mock to render the actual template files.
const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { analyzeReview, ReviewAnalysisContractError } from "../panel.js";
import { renderTemplate } from "../render.js";
import { RateLimitError } from "../rate-limit.js";
import { STAGES } from "../stages.js";
import { emptyTokenUsage } from "../tokens.js";
import {
  resolveReviewInput,
  type ResolvedReviewInput,
} from "../pr-review-input.js";
import type { PullRequestRevision } from "../pr-review.js";
import { runPullRequestReview } from "../pr-review.js";
import type { PullRequestReviewConfig } from "../review-cli.js";
import type { ReviewAnalysisResult, ReviewSeverityCounts } from "../panel.js";
import type { Finding } from "../review-severity.js";
import type { StageResult } from "../runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = join(HERE, "..", ".."); // packages/core (holds templates/)

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const EMPTY_SEVERITY: ReviewSeverityCounts = {
  blocker: 0,
  major: 0,
  minor: 0,
  nit: 0,
  suppressed: 0,
};

type Fixture = {
  workspaceDir: string;
  baseSha: string;
  headSha: string;
  revision: PullRequestRevision;
  cleanupDirs: string[];
};

const PROMPT_SECRET = "SECRET_DIRECT_PROMPT_MARKER_9Z";
const PR_BODY_MARKER = "PR_BODY_MARKER_ABC";

/** A local origin with base + PR head refs, and a cloned operator workspace. */
function setupFixture(): Fixture {
  const cleanupDirs: string[] = [];
  const mk = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p));
    cleanupDirs.push(d);
    return d;
  };
  const originDir = mk("otto-origin-");
  g(originDir, "init", "--bare", "-q");

  const seedDir = mk("otto-seed-");
  g(seedDir, "init", "-q");
  g(seedDir, "symbolic-ref", "HEAD", "refs/heads/main");
  g(seedDir, "config", "user.email", "t@t");
  g(seedDir, "config", "user.name", "t");
  writeFileSync(join(seedDir, "AGENTS.md"), "BASE trusted policy\n");
  execFileSync("mkdir", ["-p", join(seedDir, "src")]);
  writeFileSync(join(seedDir, "src", "app.ts"), "export const v = 1;\n");
  g(seedDir, "add", ".");
  g(seedDir, "commit", "-qm", "base");
  const baseSha = g(seedDir, "rev-parse", "HEAD");
  g(seedDir, "remote", "add", "origin", originDir);
  g(seedDir, "push", "-q", "origin", "HEAD:refs/heads/main");
  writeFileSync(join(seedDir, "src", "app.ts"), "export const v = 2;\n");
  g(seedDir, "add", ".");
  g(seedDir, "commit", "-qm", "head");
  const headSha = g(seedDir, "rev-parse", "HEAD");
  g(seedDir, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  g(originDir, "symbolic-ref", "HEAD", "refs/heads/main");

  const workspaceDir = mk("otto-ws-");
  execFileSync("git", ["clone", "-q", originDir, workspaceDir], {
    stdio: "ignore",
  });
  g(workspaceDir, "config", "user.email", "t@t");
  g(workspaceDir, "config", "user.name", "t");

  const revision: PullRequestRevision = {
    repository: "acme/widget",
    number: 7,
    url: "https://github.com/acme/widget/pull/7",
    title: "Add feature",
    body: PR_BODY_MARKER,
    author: "octocat",
    state: "OPEN",
    isDraft: false,
    labels: ["otto-review"],
    baseRefName: "main",
    baseSha,
    headSha,
    changedFiles: ["src/app.ts"],
  };
  return { workspaceDir, baseSha, headSha, revision, cleanupDirs };
}

function makeConfig(
  over: Partial<PullRequestReviewConfig> = {}
): PullRequestReviewConfig {
  return {
    repository: "acme/widget",
    pullRequest: 7,
    watch: false,
    watchIntervalSec: 300,
    label: "otto-review",
    reviewInput: { kind: "none" },
    output: "text",
    githubReview: false,
    ...over,
  };
}

function resolvedInput(
  fx: Fixture,
  request: ResolvedReviewInput | { kind: "none" } = { kind: "none" }
): ResolvedReviewInput {
  if ("fingerprint" in request) return request;
  return resolveReviewInput({
    workspaceDir: fx.workspaceDir,
    repository: "acme/widget",
    request,
  });
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "major",
  file: "src/app.ts",
  line: "1",
  claim: "bug introduced",
  why: "off-by-one",
  ...over,
});

type FakeCfg = {
  confirmed?: Finding[];
  rejected?: Finding[];
  severity?: ReviewSeverityCounts;
  lensCost?: number;
  verifyCost?: number;
  throwContract?: boolean;
  rateLimitOnce?: boolean;
};

/** A fake analyze that mirrors analyzeReview's decorate/record/budget contract
 *  without any model call, and records every option it was called with. */
function makeFakeAnalyze(cfg: FakeCfg = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let invocations = 0;
  const usage = () => ({
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  const fn = async (
    opts: Parameters<typeof analyzeReview>[0]
  ): Promise<ReviewAnalysisResult> => {
    calls.push(opts as unknown as Record<string, unknown>);
    const decorate = (sr: StageResult): StageResult => ({
      ...sr,
      skillsUsed: [...(sr.skillsUsed ?? []), ...(opts.skillUsages ?? [])],
      safetyEvents: [
        ...(sr.safetyEvents ?? []),
        ...(opts.inputSafetyEvents ?? []),
      ],
    });
    const mkSr = (cost: number): StageResult =>
      decorate({
        result: "ok",
        costUsd: cost,
        isError: false,
        apiErrorStatus: null,
        usage: usage(),
        runtimeId: (opts.agentId ?? "claude") as StageResult["runtimeId"],
        logPath: ".otto-tmp/logs/x.ndjson",
      });
    const stageResults: StageResult[] = [];

    if (cfg.rateLimitOnce && invocations === 0) {
      invocations++;
      const sr = mkSr(0.1);
      stageResults.push(sr);
      opts.recordStage?.("correctness", sr, "2020-01-01T00:00:00.000Z");
      throw new RateLimitError("rate limited", null);
    }
    invocations++;

    let stopped = false;
    for (const lens of opts.lenses) {
      const sr = mkSr(cfg.lensCost ?? 0.1);
      stageResults.push(sr);
      opts.recordStage?.(lens, sr, "2020-01-01T00:00:00.000Z");
      const ctrl = opts.onStage?.(sr) ?? { stop: false, cooldownFactor: 1 };
      if (ctrl.stop) {
        stopped = true;
        break;
      }
    }
    if (cfg.throwContract) {
      throw new ReviewAnalysisContractError({
        confirmed: [],
        rejected: [],
        severity: EMPTY_SEVERITY,
        stageResults,
        contractErrors: ["lenses mutated the repo (read-only violation)"],
      });
    }
    if (stopped) {
      return {
        confirmed: [],
        rejected: [],
        severity: EMPTY_SEVERITY,
        stageResults,
        contractErrors: [],
      };
    }
    const vsr = mkSr(cfg.verifyCost ?? 0.2);
    stageResults.push(vsr);
    opts.recordStage?.(
      "pr-review-verify",
      vsr,
      "2020-01-01T00:00:00.000Z",
      cfg.severity ?? EMPTY_SEVERITY
    );
    opts.onStage?.(vsr);
    return {
      confirmed: cfg.confirmed ?? [],
      rejected: cfg.rejected ?? [],
      severity: cfg.severity ?? EMPTY_SEVERITY,
      stageResults,
      contractErrors: [],
    };
  };
  return { fn, calls, invocationCount: () => invocations };
}

function readManifest(
  workspaceDir: string,
  runId: string
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(workspaceDir, ".otto", "runs", runId, "manifest.json"),
      "utf8"
    )
  );
}

const baseArgs = (fx: Fixture) => ({
  workspaceDir: fx.workspaceDir,
  packageDir: CORE_DIR,
  revision: fx.revision,
  agentId: "claude" as const,
  autoSwitchOnLimit: false,
  modelRouting: false,
  tierLadder: {} as never,
  tokenMode: "off" as const,
  contextCompressor: "off" as const,
  maxRetries: 0,
  cooldownMs: 0,
  verbose: false,
});

describe("runPullRequestReview", () => {
  let fx: Fixture;
  const out: string[] = [];
  const stdout = (t: string): void => void out.push(t);
  const now = () => new Date("2026-07-18T12:00:00.000Z");

  beforeEach(() => {
    fx = setupFixture();
    out.length = 0;
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of fx.cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  it("(1) reviews an eligible PR end to end: input artifact, worktree, skill, analysis.json, review.md, text output, finalized manifest", async () => {
    const fake = makeFakeAnalyze({
      confirmed: [finding()],
      severity: { ...EMPTY_SEVERITY, major: 1 },
    });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });

    expect(res.status).toBe("succeeded");
    expect(res.outcome).toBe("changes-requested");
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    expect(existsSync(join(runDir, "review-input.md"))).toBe(true);
    expect(existsSync(join(runDir, "pr.diff"))).toBe(true);
    expect(existsSync(join(runDir, "analysis.json"))).toBe(true);
    expect(existsSync(join(runDir, "review.md"))).toBe(true);
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
    // text output surfaced to the operator.
    expect(out.join("")).toContain("acme/widget#7");
    // finalized manifest.
    const m = readManifest(fx.workspaceDir, res.runId);
    expect(m.bin).toBe("otto-review");
    expect(m.mode).toBe("github-pr-review");
    expect(m.finishedAt).toBeTruthy();
    expect((m.pullRequestReview as { outcome: string }).outcome).toBe(
      "changes-requested"
    );
    expect((m.pullRequestReview as { confirmed: number }).confirmed).toBe(1);
    // analysis.json is schema-valid and identity-matched.
    const a = JSON.parse(readFileSync(join(runDir, "analysis.json"), "utf8"));
    expect(a.schemaVersion).toBe(1);
    expect(a.headSha).toBe(fx.headSha);
    expect(a.confirmed).toHaveLength(1);
    // analyze ran with the P32 read-only seam.
    expect(fake.calls[0].verdictSource).toBe("result");
    expect(fake.calls[0].mutationPolicy).toBe("fail");
    expect(fake.calls[0].strictFindings).toBe(true);
    expect(fake.calls[0].lensStage).toBe(STAGES.prReviewLens);
    expect(fake.calls[0].verifyStage).toBe(STAGES.prReviewVerify);
    expect(fake.calls[0].childEnv).toBeTruthy();
    expect(fake.calls[0].safetyPolicy).toBeTruthy();
  });

  it("(2) markdown mode copies the canonical document to --output-file; deps carry NO GitHub write method", async () => {
    const outFile = join(fx.workspaceDir, "review-out.md");
    const fake = makeFakeAnalyze({});
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig({ output: "markdown", outputFile: outFile }),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("succeeded");
    expect(res.outcome).toBe("approved");
    expect(existsSync(outFile)).toBe(true);
    expect(out.join("")).toContain("<!-- otto-review:");
    // The Slice-1 deps only expose getPullRequest — a compile-time guarantee
    // that no GitHub write path exists. Assert the shape at runtime too.
    expect(Object.keys(github)).toEqual(["getPullRequest"]);
  });

  it("(3) an explicit invalid skill fails BEFORE analyze runs", async () => {
    const fake = makeFakeAnalyze({});
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig({ reviewSkill: "does-not-exist" }),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("analysis-failed");
    expect(fake.calls).toHaveLength(0);
    expect(res.error).toMatch(/skill/i);
    // no canonical review published.
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    expect(existsSync(join(runDir, "review.md"))).toBe(false);
    // but a harness failure report names the identity + next action.
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain(
      "acme/widget"
    );
  });

  it("(4) a contract failure finalizes analysis-failed, publishes nothing, and cleans the worktree", async () => {
    const fake = makeFakeAnalyze({ throwContract: true });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("analysis-failed");
    expect(res.error).toMatch(/contract/i);
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    expect(existsSync(join(runDir, "review.md"))).toBe(false);
    expect(existsSync(join(runDir, "analysis.json"))).toBe(false);
    // worktree removed.
    expect(
      existsSync(
        join(fx.workspaceDir, ".otto-tmp", "pr-review-worktrees", res.runId)
      )
    ).toBe(false);
    // manifest finalized as analysis-failed.
    expect(readManifest(fx.workspaceDir, res.runId).exitReason).toBe(
      "analysis-failed"
    );
  });

  it("(5a) a moved head after analysis is superseded with supersededBy and stale evidence", async () => {
    const fake = makeFakeAnalyze({});
    const newHead = "f".repeat(40);
    const github = {
      getPullRequest: () => ({ ...fx.revision, headSha: newHead }),
    };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("superseded");
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    expect(readFileSync(join(runDir, "review.md"), "utf8")).toMatch(/stale/i);
    expect(
      (
        readManifest(fx.workspaceDir, res.runId).pullRequestReview as {
          supersededBy?: string;
        }
      ).supersededBy
    ).toBe(newHead);
  });

  it("(5b) a PR that went closed/draft/unlabelled after analysis is cancelled with stale evidence", async () => {
    for (const mutate of [
      (r: PullRequestRevision) => ({ ...r, state: "CLOSED" as const }),
      (r: PullRequestRevision) => ({ ...r, isDraft: true }),
      (r: PullRequestRevision) => ({ ...r, labels: [] }),
    ]) {
      const fake = makeFakeAnalyze({});
      const github = { getPullRequest: () => mutate(fx.revision) };
      const res = await runPullRequestReview({
        ...baseArgs(fx),
        reviewInput: resolvedInput(fx),
        config: makeConfig(),
        deps: { analyze: fake.fn, github, stdout, now },
      });
      expect(res.status).toBe("cancelled");
      const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
      expect(readFileSync(join(runDir, "review.md"), "utf8")).toMatch(/stale/i);
    }
  });

  it("(6) every stage record carries cost, usage, runtime, review severity, skill usage, safety context, log path; manifest totals sum", async () => {
    const fake = makeFakeAnalyze({
      confirmed: [finding()],
      severity: { ...EMPTY_SEVERITY, major: 1 },
      lensCost: 0.1,
      verifyCost: 0.2,
    });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    const stagesDir = join(
      fx.workspaceDir,
      ".otto",
      "runs",
      res.runId,
      "stages"
    );
    const files = execFileSync("ls", [stagesDir], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    // 5 lenses + 1 verify.
    expect(files).toHaveLength(6);
    const verify = JSON.parse(
      readFileSync(
        join(stagesDir, files.find((f) => f.includes("pr-review-verify"))!),
        "utf8"
      )
    );
    expect(verify.reviewSeverity.major).toBe(1);
    expect(verify.skillsUsed.length).toBeGreaterThan(0);
    expect(
      verify.safetyEvents.some(
        (e: { kind: string }) => e.kind === "review-input"
      )
    ).toBe(true);
    expect(
      verify.safetyEvents.some(
        (e: { kind: string }) => e.kind === "pull-request"
      )
    ).toBe(true);
    expect(verify.logPath).toBeTruthy();
    // manifest cost totals via addTokenUsage: 5*0.1 + 0.2 = 0.7, tokens 6*15.
    const m = readManifest(fx.workspaceDir, res.runId);
    expect(m.costUsd).toBeCloseTo(0.7, 5);
    expect((m.tokenUsage as { inputTokens: number }).inputTokens).toBe(60);
  });

  it("(7) budget exhaustion before verification is analysis-failed, never approved", async () => {
    const fake = makeFakeAnalyze({ lensCost: 0.5 });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      budgetUsd: 0.4, // exhausted after the first lens
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("analysis-failed");
    expect(res.outcome).toBeUndefined();
    expect(res.error).toMatch(/budget/i);
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    expect(existsSync(join(runDir, "review.md"))).toBe(false);
  });

  it("(8) a RateLimitError switches ONCE to the explicit fallback only with autoSwitchOnLimit, recording both attempts", async () => {
    const fake = makeFakeAnalyze({ rateLimitOnce: true, confirmed: [] });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      fallbackAgentId: "codex",
      autoSwitchOnLimit: true,
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("succeeded");
    // two attempts: claude then codex.
    expect(fake.invocationCount()).toBe(2);
    expect(fake.calls[0].agentId).toBe("claude");
    expect(fake.calls[1].agentId).toBe("codex");
    // both attempts recorded evidence (partial claude lens + full codex run).
    const stagesDir = join(
      fx.workspaceDir,
      ".otto",
      "runs",
      res.runId,
      "stages"
    );
    const files = execFileSync("ls", [stagesDir], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const runtimes = new Set(
      files.map(
        (f) =>
          JSON.parse(readFileSync(join(stagesDir, f), "utf8"))
            .runtimeId as string
      )
    );
    expect(runtimes.has("claude")).toBe(true);
    expect(runtimes.has("codex")).toBe(true);
  });

  it("(8b) does NOT switch when autoSwitchOnLimit is off", async () => {
    const fake = makeFakeAnalyze({ rateLimitOnce: true });
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      fallbackAgentId: "codex",
      autoSwitchOnLimit: false,
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("analysis-failed");
    expect(fake.invocationCount()).toBe(1);
  });

  it("(9) each input kind round-trips byte-identical; worktree copy is byte-identical; both stages receive REVIEW_INPUT_PATH; direct prompt never appears inline", async () => {
    const direct = resolveReviewInput({
      workspaceDir: fx.workspaceDir,
      repository: "acme/widget",
      request: { kind: "prompt", text: PROMPT_SECRET },
    });
    const fake = makeFakeAnalyze({});
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: direct,
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("succeeded");
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    // run artifact retains exact content.
    const artifact = readFileSync(join(runDir, "review-input.md"), "utf8");
    expect(artifact).toContain(PROMPT_SECRET);
    // stage vars carry a PATH to the input, not its content; no direct text inline.
    const vars = fake.calls[0].stageVars as Record<string, string>;
    expect(vars.REVIEW_INPUT_PATH).toBeTruthy();
    for (const v of Object.values(vars)) {
      expect(v).not.toContain(PROMPT_SECRET);
    }
    // injectedContext (skill) also never leaks the direct prompt.
    expect(String(fake.calls[0].injectedContext ?? "")).not.toContain(
      PROMPT_SECRET
    );
    // operator text view shows source, not the secret.
    expect(out.join("")).not.toContain(PROMPT_SECRET);
  });

  it("(10) the diff and review-input artifacts are byte-identical to the authoritative worktree/resolved values", async () => {
    const input = resolveReviewInput({
      workspaceDir: fx.workspaceDir,
      repository: "acme/widget",
      request: { kind: "prompt", text: "trailing space   \nand newline\n" },
    });
    let capturedDiffText = "";
    const fake0 = makeFakeAnalyze({});
    const fake = {
      // Capture the worktree diff CONTENT during analysis, before `finally`
      // cleans the worktree away.
      fn: async (opts: Parameters<typeof analyzeReview>[0]) => {
        const diffPath = (opts.stageVars as Record<string, string>).DIFF_PATH;
        capturedDiffText = readFileSync(diffPath, "utf8");
        return fake0.fn(opts);
      },
      calls: fake0.calls,
      invocationCount: fake0.invocationCount,
    };
    const github = { getPullRequest: () => fx.revision };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: input,
      config: makeConfig(),
      deps: { analyze: fake.fn, github, stdout, now },
    });
    expect(res.status).toBe("succeeded");
    const runDir = join(fx.workspaceDir, ".otto", "runs", res.runId);
    // run-level diff artifact equals the worktree diff the stages read.
    const runDiff = readFileSync(join(runDir, "pr.diff"), "utf8");
    expect(runDiff).toBe(capturedDiffText);
    expect(runDiff.length).toBeGreaterThan(0);
    // review-input artifact preserves exact bytes (trailing whitespace/newline).
    const artifact = readFileSync(join(runDir, "review-input.md"), "utf8");
    expect(artifact).toContain("trailing space   \nand newline");
  });

  it("(11) finalizes the manifest and cleans the worktree on a thrown pipeline error", async () => {
    const github = { getPullRequest: () => fx.revision };
    const fake = {
      fn: async () => {
        throw new Error("boom in analysis");
      },
    };
    const res = await runPullRequestReview({
      ...baseArgs(fx),
      reviewInput: resolvedInput(fx),
      config: makeConfig(),
      deps: { analyze: fake.fn as never, github, stdout, now },
    });
    expect(res.status).toBe("analysis-failed");
    expect(res.error).toMatch(/boom/);
    const m = readManifest(fx.workspaceDir, res.runId);
    expect(m.finishedAt).toBeTruthy();
    expect(
      existsSync(
        join(fx.workspaceDir, ".otto-tmp", "pr-review-worktrees", res.runId)
      )
    ).toBe(false);
  });
});

// The critical Task-3 deferral closure: the REAL analyzeReview must supply LENS
// (per-lens) and CANDIDATE_FINDINGS (per-verify), and the pipeline's stageVars
// must supply every remaining contract var, so the rendered pr-review-lens.md
// and pr-review-verify.md prompts contain the real values and NO literal `{{`.
describe("P32 template variable wiring (analyzeReview + pr-review templates)", () => {
  let ws: string;
  const rendered: Array<{ stage: string; prompt: string }> = [];

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-render-"));
    rendered.length = 0;
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mocks.executeStage
      .mockReset()
      .mockImplementation(
        async (o: {
          stage: { name: string; template: string };
          vars: Record<string, string>;
          workspaceDir: string;
        }) => {
          const spillHostDir = mkdtempSync(join(tmpdir(), "otto-spill-"));
          const prompt = renderTemplate(
            join(CORE_DIR, "templates", o.stage.template),
            o.vars,
            {
              cwd: o.workspaceDir,
              spillHostDir,
              spillRefPath: ".otto-tmp/spill",
            }
          );
          rendered.push({ stage: o.stage.name, prompt });
          rmSync(spillHostDir, { recursive: true, force: true });
          if (o.vars.LENS)
            return {
              result: "major | src/app.ts:1 | real bug | why",
              costUsd: 0.1,
              isError: false,
              apiErrorStatus: null,
              usage: emptyTokenUsage(),
              runtimeId: "claude",
            };
          return {
            result:
              "CONFIRMED major | src/app.ts:1 | real bug | verified\n<verify>done</verify>",
            costUsd: 0.2,
            isError: false,
            apiErrorStatus: null,
            usage: emptyTokenUsage(),
            runtimeId: "claude",
          };
        }
      );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("renders lens + verify prompts with real diff/input/context/candidate values and NO unreplaced {{", async () => {
    const stageVars = {
      REPO_INSTRUCTIONS_PATH: "/wt/.otto-tmp/pr-review/repo-instructions.md",
      BASE_SHA: "a".repeat(40),
      HEAD_SHA: "b".repeat(40),
      DIFF_PATH: "/wt/.otto-tmp/pr-review/diff.patch",
      REVIEW_INPUT_PATH: "/wt/.otto-tmp/pr-review/review-input.md",
      REVIEW_CONTEXT:
        "<untrusted-pull-request>PR #7 body</untrusted-pull-request>",
    };
    await analyzeReview({
      workspaceDir: ws,
      packageDir: CORE_DIR,
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      lenses: ["correctness"],
      lensStage: STAGES.prReviewLens,
      verifyStage: STAGES.prReviewVerify,
      stageVars,
      verdictSource: "result",
      strictFindings: true,
      onStage: () => ({ stop: false, cooldownFactor: 1 }),
    });

    const lens = rendered.find((r) => r.stage === "pr-review-lens");
    const verify = rendered.find((r) => r.stage === "pr-review-verify");
    expect(lens).toBeTruthy();
    expect(verify).toBeTruthy();

    // No unreplaced template variables anywhere.
    expect(lens!.prompt).not.toContain("{{");
    expect(verify!.prompt).not.toContain("{{");

    // The lens prompt carries the real contract + context values.
    expect(lens!.prompt).toContain("correctness lens");
    expect(lens!.prompt).toContain("/wt/.otto-tmp/pr-review/diff.patch");
    expect(lens!.prompt).toContain("/wt/.otto-tmp/pr-review/review-input.md");
    expect(lens!.prompt).toContain("PR #7 body");
    expect(lens!.prompt).toContain("a".repeat(40));

    // The verify prompt inlines the merged candidate findings + still reads the
    // review input path.
    expect(verify!.prompt).toContain("src/app.ts:1");
    expect(verify!.prompt).toContain("/wt/.otto-tmp/pr-review/review-input.md");
  });
});
