import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runReview, type ReviewMainDeps } from "../review-main.js";
import { ReviewInputError } from "../pr-review-input.js";
import {
  ReviewLeaseError,
  ReviewStatePersistenceError,
} from "../pr-review-state.js";
import type { PullRequestRevision } from "../pr-review.js";
import type { PullRequestReviewRunResult } from "../pr-review.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

const revision: PullRequestRevision = {
  repository: "acme/widget",
  number: 7,
  url: "https://github.com/acme/widget/pull/7",
  title: "Add feature",
  body: "body",
  author: "octocat",
  state: "OPEN",
  isDraft: false,
  labels: ["otto-review"],
  baseRefName: "main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  changedFiles: ["src/app.ts"],
};

function okResult(
  over: Partial<PullRequestReviewRunResult> = {}
): PullRequestReviewRunResult {
  return {
    status: "succeeded",
    runId: "run-1",
    repository: "acme/widget",
    pullRequest: 7,
    headSha: "b".repeat(40),
    inputFingerprint: "c".repeat(64),
    costUsd: 0.5,
    outcome: "approved",
    reviewArtifact: ".otto/runs/run-1/review.md",
    ...over,
  };
}

describe("runReview", () => {
  let cwd: string;
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null;

  const makeGithub = () => ({
    viewer: vi.fn(() => ({ login: "me" })),
    getPullRequest: vi.fn(() => revision),
    getIssue: vi.fn(() => ({
      number: 42,
      url: "https://github.com/acme/widget/issues/42",
      title: "spec",
      body: "acceptance criteria",
      state: "OPEN" as const,
      updatedAt: "2026-01-01T00:00:00Z",
    })),
    labelExists: vi.fn(() => true),
  });

  const makeDeps = (
    over: Partial<ReviewMainDeps> = {}
  ): {
    deps: Partial<ReviewMainDeps>;
    github: ReturnType<typeof makeGithub>;
    runOne: ReturnType<typeof vi.fn>;
  } => {
    const github = makeGithub();
    const runOne = vi.fn(async () => okResult());
    const deps: Partial<ReviewMainDeps> = {
      env: {},
      cwd,
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
      exit: (code: number) => {
        exitCode = code;
        return undefined as never;
      },
      createGithub: vi.fn(() => github) as never,
      runOne: runOne as never,
      runWatch: vi.fn(async () => undefined) as never,
      originUrl: () => "https://github.com/acme/widget.git",
      detach: vi.fn(() => undefined as never) as never,
      notifyComplete: vi.fn(),
      notifyError: vi.fn(),
      ...over,
    };
    return { deps, github, runOne };
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "otto-review-main-"));
    out.length = 0;
    err.length = 0;
    exitCode = null;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("--version exits before any GitHub call and forwards the package version", async () => {
    const { deps, github, runOne } = makeDeps();
    await runReview(["--version"], { cliVersion: "9.9.9", deps });
    expect(out.join("")).toContain("9.9.9");
    expect(out.join("")).toContain("core");
    expect(
      deps.createGithub as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(runOne).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("--help exits before preflight", async () => {
    const { deps, runOne } = makeDeps();
    await runReview(["--help"], { deps });
    expect(out.join("")).toContain("otto-review — automated pull-request");
    expect(runOne).not.toHaveBeenCalled();
  });

  it("--print-config shows resolved config + preflight with no model/GitHub fetch, redacting prompt content and writing no input artifact", async () => {
    const { deps, github, runOne } = makeDeps();
    await runReview(
      [
        "--repo",
        "acme/widget",
        "--pr",
        "7",
        "--prompt",
        "SUPER_SECRET_PROMPT",
        "--print-config",
      ],
      { deps }
    );
    const printed = out.join("");
    expect(printed).toContain("pull-request review config");
    expect(printed).toContain("preflight");
    // redacts the direct prompt content (only the char count is shown).
    expect(printed).not.toContain("SUPER_SECRET_PROMPT");
    expect(printed).toContain("direct (");
    // labels the deferred GitHub checks.
    expect(printed).toContain("deferred");
    // no model, no issue fetch, no PR fetch, no input artifact.
    expect(runOne).not.toHaveBeenCalled();
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(exitCode).toBeNull();
  });

  it("--watch dispatches the daemon with the unresolved review input and daemon controls, resolving no issue first", async () => {
    const { deps, github, runOne } = makeDeps();
    const runWatch = deps.runWatch as ReturnType<typeof vi.fn>;
    await runReview(
      [
        "--repo",
        "acme/widget",
        "--watch",
        "--spec-issue",
        "42",
        "--budget",
        "5",
      ],
      { deps }
    );
    expect(runWatch).toHaveBeenCalledTimes(1);
    const arg = runWatch.mock.calls[0][0] as {
      config: { watch: boolean; output: string; reviewInput: { kind: string } };
      budgetUsd?: number;
    };
    // the daemon receives the UNRESOLVED review input request (child owns the
    // per-poll snapshot) — the parent never resolved the issue.
    expect(arg.config.watch).toBe(true);
    expect(arg.config.reviewInput.kind).toBe("github-issue");
    expect(arg.config.output).toBe("comment");
    expect(arg.budgetUsd).toBe(5);
    expect(github.getIssue).not.toHaveBeenCalled();
    // the one-shot pipeline is not used for a watch run.
    expect(runOne).not.toHaveBeenCalled();
    expect(exitCode).toBeNull();
  });

  it("--watch --detach forks via the injected detach seam before running the daemon", async () => {
    const detach = vi.fn(() => undefined as never);
    const { deps } = makeDeps({ detach: detach as never });
    const runWatch = deps.runWatch as ReturnType<typeof vi.fn>;
    await runReview(["--repo", "acme/widget", "--watch", "--detach"], { deps });
    expect(detach).toHaveBeenCalledTimes(1);
    // detach is a `never`-returning fork; our fake returns, so the daemon still
    // runs in-test, but a real detach would have exited the parent first.
    const detachArg = detach.mock.calls[0][0] as { argv: string[] };
    expect(detachArg.argv).toContain("--watch");
  });

  it("a failed remote preflight sets a clean one-line error and never runs the pipeline", async () => {
    const { deps, runOne } = makeDeps({
      originUrl: () => "https://github.com/someone/else.git",
    });
    await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
    expect(err.join("")).toMatch(/preflight failed/);
    expect(err.join("").split("\n").filter(Boolean)).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(runOne).not.toHaveBeenCalled();
  });

  it("resolves the selected input before the pipeline; a same-repo issue uses the existing client", async () => {
    const { deps, github, runOne } = makeDeps();
    await runReview(
      ["--repo", "acme/widget", "--pr", "7", "--spec-issue", "42"],
      { deps }
    );
    expect(github.getIssue).toHaveBeenCalledWith("acme/widget", 42);
    expect(runOne).toHaveBeenCalledTimes(1);
    // input resolved BEFORE the pipeline; runOne receives the resolved snapshot.
    const arg = runOne.mock.calls[0][0] as { reviewInput: { kind: string } };
    expect(arg.reviewInput.kind).toBe("github-issue");
  });

  it("a no-input one-shot never calls getIssue but still runs the pipeline", async () => {
    const { deps, github, runOne } = makeDeps();
    await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).toHaveBeenCalledWith("acme/widget", 7);
    expect(runOne).toHaveBeenCalledTimes(1);
  });

  it("an invalid input never invokes the pipeline or a model", async () => {
    const badResolve = vi.fn(() => {
      throw new ReviewInputError("not-found", "spec file not found");
    });
    const { deps, runOne } = makeDeps({ resolveInput: badResolve as never });
    await runReview(
      ["--repo", "acme/widget", "--pr", "7", "--spec-file", "missing.md"],
      { deps }
    );
    expect(err.join("")).toMatch(/review input error/);
    expect(exitCode).toBe(1);
    expect(runOne).not.toHaveBeenCalled();
  });

  it("forwards --notify to the injected completion notifier from the run result", async () => {
    const { deps } = makeDeps();
    await runReview(["--repo", "acme/widget", "--pr", "7", "--notify"], {
      deps,
    });
    expect(
      deps.notifyComplete as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledWith(1, true);
  });

  describe("run-result exit-code contract", () => {
    it("succeeded exits cleanly (exit not called)", async () => {
      const { deps } = makeDeps();
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
    });

    it("publish-failed exits 1 and names the failure on stderr", async () => {
      const publishFailedRunOne = vi.fn(async () =>
        okResult({ status: "publish-failed", error: "comment API 500" })
      );
      const { deps } = makeDeps({ runOne: publishFailedRunOne as never });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(publishFailedRunOne).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/publish.*failed/i);
      expect(err.join("")).toContain("comment API 500");
    });

    it("a retryable publish-failed says it is retryable via re-run, not that it will be retried automatically", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "publish-failed",
            error: "rate limited",
            retryable: true,
            nextRetryAt: "2026-01-01T00:05:00Z",
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/retryable/i);
      expect(err.join("")).toMatch(/re-run/i);
      expect(err.join("")).toContain("2026-01-01T00:05:00Z");
      // one-shot mode has no automatic retry loop — never promise one.
      expect(err.join("")).not.toMatch(/will be retried/i);
    });

    it("a non-retryable publish-failed says it is a permanent failure", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "publish-failed",
            error: "422 unprocessable",
            retryable: false,
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/permanent/i);
      expect(err.join("")).not.toMatch(/will be retried/i);
    });

    it("a publish-failed with a published summary comment names it as delivered", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "publish-failed",
            error: "review submission failed",
            commentId: 555,
            retryable: true,
            nextRetryAt: "2026-01-01T00:05:00Z",
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/comment.*(published|delivered)/i);
      expect(err.join("")).toMatch(/retryable/i);
      expect(err.join("")).toMatch(/re-run/i);
      expect(err.join("")).not.toMatch(/will be retried/i);
    });

    it("analysis-failed exits 1 with the existing message (unchanged)", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "analysis-failed", error: "model timed out" })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/review failed/);
      expect(err.join("")).toContain("model timed out");
    });

    it("superseded with no remote output states nothing was published", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "superseded", commentId: undefined })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
      expect(err.join("")).toMatch(/head changed/i);
      expect(err.join("")).toMatch(/no.*output.*published/i);
    });

    it("superseded with an already-published comment states the comment was delivered and only the review was withheld", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "superseded", commentId: 42 })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
      expect(err.join("")).toMatch(/head changed/i);
      expect(err.join("")).toMatch(/comment.*(published|delivered)/i);
      expect(err.join("")).toMatch(/review.*withheld|withheld.*review/i);
      // must not claim nothing was delivered when a comment was actually published.
      expect(err.join("")).not.toMatch(/no.*output.*(published|delivered)/i);
    });

    it("cancelled with no remote output states nothing was published", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "cancelled", commentId: undefined })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
      expect(err.join("")).toMatch(/closed|draft|unlabell?ed/i);
      expect(err.join("")).toMatch(/no.*output.*published/i);
    });

    it("cancelled with an already-published comment states the comment was delivered and only the review was withheld", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "cancelled", commentId: 42 })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
      expect(err.join("")).toMatch(/closed|draft|unlabell?ed/i);
      expect(err.join("")).toMatch(/comment.*(published|delivered)/i);
      expect(err.join("")).toMatch(/review.*withheld|withheld.*review/i);
      expect(err.join("")).not.toMatch(/no.*output.*(published|delivered)/i);
    });

    it("skipped busy states another process is already reviewing and no work was done, exit 0 (independent of costUsd)", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({ status: "skipped", skipReason: "busy", costUsd: 0 })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBeNull();
      expect(err.join("")).toMatch(/already.*reviewing/i);
      expect(err.join("")).toMatch(/no work was done/i);
    });

    it("skipped interrupted states analysis completed but publication was interrupted, is resumable, and exits 1", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "skipped",
            skipReason: "interrupted",
            costUsd: 0.42,
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/analysis (completed|ran)/i);
      expect(err.join("")).toMatch(/resum/i);
      expect(err.join("")).not.toMatch(/no work was done/i);
    });

    it("skipped interrupted with costUsd:0 (the Codex case) is NOT misreported as busy — still resumable message + exit 1", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "skipped",
            skipReason: "interrupted",
            costUsd: 0,
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      expect(err.join("")).toMatch(/analysis (completed|ran)/i);
      expect(err.join("")).toMatch(/resum/i);
      expect(err.join("")).not.toMatch(/already.*reviewing/i);
      expect(err.join("")).not.toMatch(/no work was done/i);
    });

    it("skipped aborted-before-work states no analysis/state was saved (accurate, distinct from interrupted and busy), exits 1", async () => {
      const { deps } = makeDeps({
        runOne: vi.fn(async () =>
          okResult({
            status: "skipped",
            skipReason: "aborted-before-work",
            costUsd: 0,
          })
        ) as never,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(exitCode).toBe(1);
      // Must NOT falsely claim analysis completed or state was saved.
      expect(err.join("")).not.toMatch(/analysis (completed|ran)/i);
      expect(err.join("")).not.toMatch(/state was saved/i);
      // Must NOT be mistaken for the busy message either.
      expect(err.join("")).not.toMatch(/already.*reviewing/i);
      expect(err.join("")).toMatch(/re-run/i);
    });
  });

  describe("one-shot PR eligibility gate", () => {
    it("a draft PR is never analyzed: exits 1 before runOne, naming the reason", async () => {
      const { deps, github, runOne } = makeDeps();
      (github.getPullRequest as ReturnType<typeof vi.fn>).mockReturnValue({
        ...revision,
        isDraft: true,
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(runOne).not.toHaveBeenCalled();
      expect(exitCode).toBe(1);
      expect(err.join("")).toContain("acme/widget#7");
      expect(err.join("")).toMatch(/draft/);
    });

    it("a closed PR is never analyzed: exits 1 before runOne, naming the reason", async () => {
      const { deps, github, runOne } = makeDeps();
      (github.getPullRequest as ReturnType<typeof vi.fn>).mockReturnValue({
        ...revision,
        state: "CLOSED",
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(runOne).not.toHaveBeenCalled();
      expect(exitCode).toBe(1);
      expect(err.join("")).toContain("acme/widget#7");
      expect(err.join("")).toMatch(/closed/);
    });

    it("an unlabelled PR is never analyzed: exits 1 before runOne, naming the reason", async () => {
      const { deps, github, runOne } = makeDeps();
      (github.getPullRequest as ReturnType<typeof vi.fn>).mockReturnValue({
        ...revision,
        labels: [],
      });
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(runOne).not.toHaveBeenCalled();
      expect(exitCode).toBe(1);
      expect(err.join("")).toContain("acme/widget#7");
      expect(err.join("")).toMatch(/label/);
    });

    it("an eligible PR (open, non-draft, labelled) still runs the pipeline", async () => {
      const { deps, github, runOne } = makeDeps();
      await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
      expect(github.getPullRequest).toHaveBeenCalledWith("acme/widget", 7);
      expect(runOne).toHaveBeenCalledTimes(1);
      expect(exitCode).toBeNull();
    });
  });

  it("the flat bin mirrors the existing thin bins and package.json exposes otto-review", () => {
    const bin = readFileSync(
      join(REPO_ROOT, "apps", "cli", "bin", "otto-review.js"),
      "utf8"
    );
    expect(bin).toContain("#!/usr/bin/env node");
    expect(bin).toContain("import { runReview }");
    expect(bin).toContain("runReview(process.argv.slice(2), { cliVersion })");
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf8")
    );
    expect(pkg.bin["otto-review"]).toBe("./bin/otto-review.js");
  });

  // -------------------------------------------------------------------------
  // Task 3 — shared preflight for watch + typed one-shot error surfacing.
  // -------------------------------------------------------------------------

  it("--watch runs the SAME viewer/auth preflight as one-shot BEFORE polling; a failed viewer never starts the daemon", async () => {
    const { deps, github, runOne } = makeDeps();
    const runWatch = deps.runWatch as ReturnType<typeof vi.fn>;
    github.viewer.mockImplementation(() => {
      throw new Error("bad credentials");
    });
    await runReview(["--repo", "acme/widget", "--watch"], { deps });
    expect(runWatch).not.toHaveBeenCalled();
    expect(runOne).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(err.join("")).toMatch(/authentication failed/i);
  });

  it("--watch runs the exact-label + origin preflight; a missing label never starts the daemon", async () => {
    const { deps, github } = makeDeps();
    const runWatch = deps.runWatch as ReturnType<typeof vi.fn>;
    github.labelExists.mockReturnValue(false);
    await runReview(["--repo", "acme/widget", "--watch"], { deps });
    expect(github.labelExists).toHaveBeenCalledWith(
      "acme/widget",
      "otto-review"
    );
    expect(runWatch).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(err.join("")).toMatch(/preflight failed/i);
  });

  it("--watch starts the daemon only AFTER the shared preflight passes", async () => {
    const { deps, github } = makeDeps();
    const runWatch = deps.runWatch as ReturnType<typeof vi.fn>;
    await runReview(["--repo", "acme/widget", "--watch"], { deps });
    expect(github.viewer).toHaveBeenCalled();
    expect(github.labelExists).toHaveBeenCalledWith(
      "acme/widget",
      "otto-review"
    );
    expect(runWatch).toHaveBeenCalledTimes(1);
    expect(exitCode).toBeNull();
  });

  it("a typed lease failure from a one-shot run surfaces ONE actionable line (no raw stack), exit 1", async () => {
    const runOne = vi.fn(async () => {
      throw new ReviewLeaseError(
        "otto-review could not acquire its OS file lock (ENOTSUP)",
        { code: "ENOTSUP" }
      );
    });
    const { deps } = makeDeps({ runOne: runOne as never });
    await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
    expect(exitCode).toBe(1);
    const line = err.join("");
    expect(line).toMatch(/review failed:/);
    expect(line).toMatch(/ENOTSUP/);
    // A single actionable line — never a multi-frame raw stack trace.
    expect(line).not.toMatch(/\n\s+at /);
  });

  it("a typed durable-state failure from a one-shot run surfaces one line, exit 1", async () => {
    const runOne = vi.fn(async () => {
      throw new ReviewStatePersistenceError("durable state write failed", {
        path: "/ws/.otto/review-state/x.json",
      });
    });
    const { deps } = makeDeps({ runOne: runOne as never });
    await runReview(["--repo", "acme/widget", "--pr", "7"], { deps });
    expect(exitCode).toBe(1);
    expect(err.join("")).toMatch(/review failed:.*durable state write failed/);
  });
});
