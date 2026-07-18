/**
 * P32 `otto-review` main (Slice 1): parse the review-only flags, resolve the
 * run config, handle `--help`/`--version`/`--print-config` before any model or
 * GitHub call, run the local/remote/input preflight, then drive exactly one
 * {@link runPullRequestReview}. `--watch` is not available until Slice 2. Every
 * external seam (GitHub client, input resolution, the pipeline, notifiers,
 * origin lookup) is injectable so the CLI is testable without real GitHub or
 * model calls.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readAgentConfig,
  readFallbackConfig,
  resolveAgentRuntime,
  resolveFallback,
} from "./agent-runtime.js";
import { readCoreVersion } from "./cli-help.js";
import { readCompressorMode } from "./context-compressor.js";
import { detachAndExit } from "./detach.js";
import { createGitHubPrClient } from "./github-pr.js";
import { resolveTierLadder } from "./model-tier.js";
import { notifyComplete, notifyError } from "./notify.js";
import { runPreflight, runReviewPreflight } from "./preflight.js";
import { resolveReviewInput, ReviewInputError } from "./pr-review-input.js";
import { ineligibleReason, runPullRequestReview } from "./pr-review.js";
import { runPullRequestReviewWatch } from "./pr-review-watch.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import {
  formatReviewConfig,
  formatReviewHelp,
  parseReviewFlags,
  readPullRequestReviewConfig,
  resolvePullRequestReviewConfig,
  type PullRequestReviewConfig,
} from "./review-cli.js";
import type { TokenMode } from "./tokens.js";

/** Injectable seams for {@link runReview} (tests supply fakes). */
export type ReviewMainDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => never;
  createGithub: typeof createGitHubPrClient;
  resolveInput: typeof resolveReviewInput;
  runOne: typeof runPullRequestReview;
  runWatch: typeof runPullRequestReviewWatch;
  originUrl: (workspaceDir: string) => string | null;
  detach: typeof detachAndExit;
  notifyComplete: typeof notifyComplete;
  notifyError: typeof notifyError;
};

export type RunReviewOptions = {
  cliVersion?: string;
  deps?: Partial<ReviewMainDeps>;
};

/** `git remote get-url origin` (literal argv). Returns null when absent/failing. */
function defaultOriginUrl(workspaceDir: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: workspaceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function runReview(
  argv: string[],
  opts: RunReviewOptions = {}
): Promise<void> {
  const deps: ReviewMainDeps = {
    env: opts.deps?.env ?? process.env,
    cwd: opts.deps?.cwd ?? process.cwd(),
    stdout: opts.deps?.stdout ?? ((t) => void process.stdout.write(t)),
    stderr: opts.deps?.stderr ?? ((t) => void process.stderr.write(t)),
    exit: opts.deps?.exit ?? ((code) => process.exit(code)),
    createGithub: opts.deps?.createGithub ?? createGitHubPrClient,
    resolveInput: opts.deps?.resolveInput ?? resolveReviewInput,
    runOne: opts.deps?.runOne ?? runPullRequestReview,
    runWatch: opts.deps?.runWatch ?? runPullRequestReviewWatch,
    originUrl: opts.deps?.originUrl ?? defaultOriginUrl,
    detach: opts.deps?.detach ?? detachAndExit,
    notifyComplete: opts.deps?.notifyComplete ?? notifyComplete,
    notifyError: opts.deps?.notifyError ?? notifyError,
  };

  // Parse flags. --help/--version short-circuit before any resolution/preflight.
  let flags;
  try {
    flags = parseReviewFlags(argv);
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n`);
    return deps.exit(1);
  }

  if (flags.version) {
    deps.stdout(
      `otto-review ${opts.cliVersion ?? "?"} (core ${readCoreVersion()})\n`
    );
    return;
  }
  if (flags.help) {
    deps.stdout(formatReviewHelp());
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);

  // Resolve the run config (flag > env > config > default). A structural error
  // (missing --repo, bad --pr/--watch pairing, …) is a clean one-line failure.
  let config;
  try {
    config = resolvePullRequestReviewConfig({
      flags,
      env: deps.env,
      config: readPullRequestReviewConfig(workspaceDir),
    });
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n`);
    return deps.exit(1);
  }

  // Resolve the runtime knobs (mirrors runBin). Invalid values are fatal on a
  // real run; --print-config still reports the resolved config first.
  const agent = resolveAgentRuntime({
    flag: flags.agent,
    env: deps.env.OTTO_AGENT,
    config: readAgentConfig(workspaceDir),
  });
  const fbCfg = readFallbackConfig(workspaceDir);
  const fallback = resolveFallback({
    flagAgent: flags.fallbackAgent,
    envAgent: deps.env.OTTO_FALLBACK_AGENT,
    configAgent: fbCfg.agent,
    flagAutoSwitch: flags.autoSwitchOnLimit,
    envAutoSwitch: deps.env.OTTO_AUTO_SWITCH_ON_LIMIT,
    configAutoSwitch: fbCfg.autoSwitch,
  });
  const tierLadder = resolveTierLadder(deps.env);
  const contextCompressor = readCompressorMode(
    workspaceDir,
    deps.env,
    flags.contextCompressor
  );
  const tokenMode: TokenMode = flags.tokenMode ?? "off";

  // --print-config: local probes only. Redacts prompt text (via
  // formatReviewConfig), performs NO issue fetch or input-artifact write, and
  // labels the GitHub label/issue checks as deferred until a real run.
  if (flags.printConfig) {
    deps.stdout(formatReviewConfig(config));
    const local = runPreflight({
      bin: "otto-review",
      workspaceDir,
      agentId: agent.id,
    });
    const originUrl = deps.originUrl(workspaceDir);
    const originCheck = runReviewPreflight({
      workspaceDir,
      repository: config.repository,
      label: config.label,
      originUrl,
      labelExists: true, // not consulted for the label line below (deferred)
    }).filter((r) => r.label === "repository origin");
    const lines = [
      ...local.map(
        (r) => `  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(20)}${r.detail}`
      ),
      ...originCheck.map(
        (r) => `  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(20)}${r.detail}`
      ),
      `  · ${"review label".padEnd(20)}deferred — checked against GitHub on a real run`,
      `  · ${"review input".padEnd(20)}deferred — resolved on a real run`,
    ];
    deps.stdout(`\n[otto-review] preflight\n${lines.join("\n")}\n`);
    return;
  }

  // --watch (Slice 2): run the sequential labelled-PR daemon. Optionally fork
  // into the background FIRST (the child owns per-poll snapshots — we resolve no
  // issue/file here), then poll+review continuously until abort/budget.
  if (config.watch) {
    if (flags.detach) {
      const logPath =
        flags.log ??
        resolve(workspaceDir, ".otto-tmp", "logs", `review-${process.pid}.log`);
      deps.detach({ logPath, argv, binEntry: process.argv[1] });
    }
    await deps.runWatch({
      workspaceDir,
      packageDir,
      config: config as PullRequestReviewConfig & { watch: true },
      agentId: agent.id,
      fallbackAgentId: fallback.agent?.id,
      autoSwitchOnLimit: fallback.autoSwitch,
      modelRouting: flags.modelRouting,
      tierLadder,
      tokenMode,
      contextCompressor,
      maxRetries: flags.maxRetries ?? DEFAULT_MAX_RETRIES,
      cooldownMs: flags.cooldownMs ?? 0,
      budgetUsd: flags.budget,
      notify: flags.notify,
      verbose: flags.verbose,
    });
    return;
  }

  if (config.pullRequest == null) {
    deps.stderr("--pr <number|url> is required for a one-shot review\n");
    return deps.exit(1);
  }
  const pullRequest = config.pullRequest;

  // Real run: remote + input preflight through the same client before any model.
  const github = deps.createGithub({ cwd: workspaceDir });

  // Auth check (viewer) fails closed with a clean one-line error.
  try {
    github.viewer();
  } catch (err) {
    deps.stderr(`GitHub authentication failed: ${(err as Error).message}\n`);
    return deps.exit(1);
  }

  let labelExists = false;
  try {
    labelExists = github.labelExists(config.repository, config.label);
  } catch (err) {
    deps.stderr(`GitHub label check failed: ${(err as Error).message}\n`);
    return deps.exit(1);
  }

  const originUrl = deps.originUrl(workspaceDir);
  const preflight = runReviewPreflight({
    workspaceDir,
    repository: config.repository,
    label: config.label,
    originUrl,
    labelExists,
  });
  const failed = preflight.find((r) => !r.ok);
  if (failed) {
    deps.stderr(`preflight failed: ${failed.detail}\n`);
    return deps.exit(1);
  }

  // Resolve the selected review input BEFORE fetching PR metadata or a model.
  // An invalid issue/file/prompt input never invokes the pipeline.
  let reviewInput;
  try {
    reviewInput = deps.resolveInput({
      workspaceDir,
      repository: config.repository,
      request: config.reviewInput,
      github,
    });
  } catch (err) {
    if (err instanceof ReviewInputError) {
      deps.stderr(`review input error: ${err.message}\n`);
      return deps.exit(1);
    }
    deps.stderr(`review input error: ${(err as Error).message}\n`);
    return deps.exit(1);
  }

  let revision;
  try {
    revision = github.getPullRequest(config.repository, pullRequest);
  } catch (err) {
    deps.stderr(
      `failed to fetch ${config.repository}#${pullRequest}: ${(err as Error).message}\n`
    );
    return deps.exit(1);
  }

  // Eligibility gate BEFORE the (paid) pipeline: a closed/draft/unlabelled PR
  // is never claimed, worktree'd, or model-analyzed for a one-shot run. Watch
  // mode already filters eligibility on its own poll loop, so this check is
  // one-shot only.
  const ineligible = ineligibleReason(revision, config.label);
  if (ineligible) {
    deps.stderr(
      `PR ${config.repository}#${pullRequest} is not eligible for review: ${ineligible}\n`
    );
    return deps.exit(1);
  }

  const result = await deps.runOne({
    workspaceDir,
    packageDir,
    revision,
    reviewInput,
    config,
    agentId: agent.id,
    fallbackAgentId: fallback.agent?.id,
    autoSwitchOnLimit: fallback.autoSwitch,
    modelRouting: flags.modelRouting,
    tierLadder,
    tokenMode,
    contextCompressor,
    maxRetries: flags.maxRetries ?? DEFAULT_MAX_RETRIES,
    cooldownMs: flags.cooldownMs ?? 0,
    budgetUsd: flags.budget,
    verbose: flags.verbose,
    deps: {
      github,
      stdout: deps.stdout,
      env: deps.env,
    },
  });

  // Notification is advisory — it never changes the run result.
  if (flags.notify) {
    if (result.status === "analysis-failed") {
      deps.notifyError(result.error ?? "review analysis failed");
    } else {
      deps.notifyComplete(1, result.status === "succeeded");
    }
  }

  // Explicit run-result -> exit-code contract for every terminal status:
  //   succeeded      -> 0 (falls through below).
  //   publish-failed -> 1: the analysis ran (was paid for) but the requested
  //                     GitHub output was NOT delivered — a script must see
  //                     this as a failure even though nothing crashed.
  //   analysis-failed-> 1 (unchanged).
  //   superseded     -> 0: the PR head changed under us; declining to publish
  //                     against a stale head is correct, not a failure.
  //   cancelled      -> 0: the PR became closed/draft/unlabelled mid-run;
  //                     declining to publish is correct, not a failure.
  //   skipped        -> 0: another process already holds the review lease for
  //                     this revision; no analysis ran and no output was
  //                     published.
  if (result.status === "publish-failed") {
    const retryNote = result.retryable
      ? ` (will be retried${result.nextRetryAt ? ` at ${result.nextRetryAt}` : ""})`
      : "";
    deps.stderr(
      `publish failed: ${result.error ?? "unknown error"} — no remote output was delivered${retryNote}\n`
    );
    return deps.exit(1);
  }

  if (result.status === "analysis-failed") {
    deps.stderr(`review failed: ${result.error ?? "analysis failed"}\n`);
    return deps.exit(1);
  }

  if (result.status === "superseded") {
    deps.stderr(
      `review declined: the PR head changed during the run — no remote output was published\n`
    );
    return;
  }

  if (result.status === "cancelled") {
    deps.stderr(
      `review declined: the PR was closed, drafted, or unlabelled during the run — no remote output was published\n`
    );
    return;
  }

  if (result.status === "skipped") {
    deps.stderr(
      `review skipped: another process is already reviewing this revision — no work was done\n`
    );
    return;
  }
}
