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
import {
  ReviewLeaseError,
  ReviewStatePersistenceError,
} from "./pr-review-state.js";
import type { GitHubPrClient } from "./github-pr.js";
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

/**
 * The SHARED remote review preflight run by both a one-shot AND a watch run
 * before ANY polling / model work: GitHub viewer/auth and the origin/repository
 * match always; the exact-label existence check ONLY when `requireLabel` is
 * true. Returns a single actionable error line on the first failure, or
 * `{ ok: true }` when every gate passes.
 *
 * `requireLabel` is true for watch (label filtering is watch's whole purpose —
 * it must never silently start against a missing label) and false for a
 * one-shot run (the user explicitly named the PR with `--pr`, so the
 * configured label need not exist in the repo at all — see the
 * one-shot-vs-watch split in {@link runReview}).
 */
function runReviewRemotePreflight(opts: {
  github: Pick<GitHubPrClient, "viewer" | "labelExists">;
  workspaceDir: string;
  repository: string;
  label: string;
  originUrl: string | null;
  requireLabel: boolean;
}): { ok: true } | { ok: false; message: string } {
  try {
    opts.github.viewer();
  } catch (err) {
    return {
      ok: false,
      message: `GitHub authentication failed: ${(err as Error).message}`,
    };
  }

  let labelExists = true;
  if (opts.requireLabel) {
    try {
      labelExists = opts.github.labelExists(opts.repository, opts.label);
    } catch (err) {
      return {
        ok: false,
        message: `GitHub label check failed: ${(err as Error).message}`,
      };
    }
  }

  const preflight = runReviewPreflight({
    workspaceDir: opts.workspaceDir,
    repository: opts.repository,
    label: opts.label,
    originUrl: opts.originUrl,
    labelExists,
  }).filter((r) => opts.requireLabel || r.label !== "review label");
  const failed = preflight.find((r) => !r.ok);
  if (failed)
    return { ok: false, message: `preflight failed: ${failed.detail}` };
  return { ok: true };
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

    // SHARED preflight: watch runs the SAME viewer/auth + exact-label +
    // origin/repository checks as a one-shot run, here AFTER any detached-child
    // establishment and BEFORE the poll loop — so the daemon never starts
    // polling/model work against a bad auth, missing label, or wrong origin.
    const watchGithub = deps.createGithub({ cwd: workspaceDir });
    const watchOriginUrl = deps.originUrl(workspaceDir);
    const watchPreflight = runReviewRemotePreflight({
      github: watchGithub,
      workspaceDir,
      repository: config.repository,
      label: config.label,
      originUrl: watchOriginUrl,
      requireLabel: true,
    });
    if (!watchPreflight.ok) {
      deps.stderr(`${watchPreflight.message}\n`);
      return deps.exit(1);
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

  // The SHARED remote preflight (viewer/auth + origin) — the SAME auth/origin
  // checks watch runs before polling. The exact-label existence check is
  // SKIPPED here: the user explicitly named this PR with `--pr`, so unlike
  // watch (whose whole purpose is label-based filtering), a one-shot run does
  // not require the configured label to exist in the repo at all. Fails
  // closed with a clean one-line error.
  const originUrl = deps.originUrl(workspaceDir);
  const preflight = runReviewRemotePreflight({
    github,
    workspaceDir,
    repository: config.repository,
    label: config.label,
    originUrl,
    requireLabel: false,
  });
  if (!preflight.ok) {
    deps.stderr(`${preflight.message}\n`);
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

  // Eligibility gate BEFORE the (paid) pipeline: a closed/draft PR is never
  // claimed, worktree'd, or model-analyzed for a one-shot run. Watch mode
  // already filters eligibility (including the label) on its own poll loop,
  // so this check is one-shot only. UNLIKE watch, a one-shot run never
  // declines on "label-missing" — the user explicitly named this PR with
  // `--pr`, so it is reviewed regardless of label; only closed/draft still
  // block.
  const ineligible = ineligibleReason(revision, config.label);
  if (ineligible && ineligible !== "label-missing") {
    deps.stderr(
      `PR ${config.repository}#${pullRequest} is not eligible for review: ${ineligible}\n`
    );
    return deps.exit(1);
  }

  let result;
  try {
    result = await deps.runOne({
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
  } catch (err) {
    // Typed lease/storage/platform failures surface as ONE actionable line (no
    // raw stack), exit 1: an unusable OS file lock ({@link ReviewLeaseError},
    // e.g. missing/broken fs-ext or ENOTSUP) or a durable-state write failure
    // ({@link ReviewStatePersistenceError}) means the review could not run
    // safely — never a silent success.
    if (
      err instanceof ReviewLeaseError ||
      err instanceof ReviewStatePersistenceError
    ) {
      deps.stderr(`review failed: ${err.message}\n`);
      if (flags.notify) deps.notifyError(err.message);
      return deps.exit(1);
    }
    throw err;
  }

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
  //   skipped        -> driven by `result.skipReason` (NOT costUsd — Codex
  //                     stages report costUsd:0, so a cost heuristic misreports
  //                     an interrupted Codex run as busy):
  //                       "busy"        -> 0: another process already holds the
  //                                       review lease; no analysis ran and no
  //                                       output was published.
  //                       "interrupted" -> 1: paid analysis completed and a
  //                                       resumable state was persisted, but
  //                                       publication did NOT finish — a script
  //                                       must see this as a failure so a missing
  //                                       publication is never read as success.
  //                       "aborted-before-work" -> 1: the caller signal was
  //                                       already aborted right after the
  //                                       lease was acquired, BEFORE any
  //                                       analysis ran — no analysis completed
  //                                       and no resumable state was
  //                                       persisted. The requested review was
  //                                       still not delivered, so a script
  //                                       must see this as a failure too.
  if (result.status === "publish-failed") {
    const delivered: string[] = [];
    if (result.commentId != null) {
      delivered.push(
        `the summary comment was published (id ${result.commentId})`
      );
    }
    if (result.reviewId != null) {
      delivered.push(`the review was published (id ${result.reviewId})`);
    }
    const deliveredNote =
      delivered.length > 0
        ? ` — ${delivered.join(" and ")}, but the remaining output failed to publish`
        : " — no remote output was delivered";
    // One-shot mode has no automatic retry loop (only the watch daemon
    // retries) — never promise a retry that will not happen on its own.
    const retryNote = result.retryable
      ? ` (retryable — re-run to retry${result.nextRetryAt ? `; eligible again at ${result.nextRetryAt}` : ""})`
      : " (permanent failure — not retryable)";
    deps.stderr(
      `publish failed: ${result.error ?? "unknown error"}${deliveredNote}${retryNote}\n`
    );
    return deps.exit(1);
  }

  if (result.status === "analysis-failed") {
    deps.stderr(`review failed: ${result.error ?? "analysis failed"}\n`);
    return deps.exit(1);
  }

  if (result.status === "superseded") {
    const outputNote =
      result.commentId != null
        ? `the summary comment was already published (id ${result.commentId}); the review was withheld because the head changed`
        : "no remote output was published";
    deps.stderr(
      `review declined: the PR head changed during the run — ${outputNote}\n`
    );
    return;
  }

  if (result.status === "cancelled") {
    const outputNote =
      result.commentId != null
        ? `the summary comment was already published (id ${result.commentId}); the review was withheld because of the change`
        : "no remote output was published";
    deps.stderr(
      `review declined: the PR was closed, drafted, or unlabelled during the run — ${outputNote}\n`
    );
    return;
  }

  if (result.status === "skipped") {
    // EXPLICIT reason drives the message AND exit code — never costUsd (Codex
    // stages report costUsd:0 even for an interrupted-after-analysis run, so a
    // cost heuristic would misreport it as busy and exit 0 despite a missing
    // publication).
    if (result.skipReason === "interrupted") {
      // Paid analysis ran and a resumable state was persisted, but publication
      // did not finish. Exit NONZERO so scripts do not read a missing
      // publication as success; re-running resumes from the saved analysis.
      deps.stderr(
        `review skipped: analysis completed but publication was interrupted — run state was saved; re-run to resume\n`
      );
      return deps.exit(1);
    }
    if (result.skipReason === "aborted-before-work") {
      // The lease was acquired but the caller shut down BEFORE any analysis
      // ran — unlike "interrupted", no analysis completed and no resumable
      // state was persisted, so the message must not claim either. Exit
      // NONZERO: the requested review was still not delivered.
      deps.stderr(
        `review skipped: aborted before any work started — re-run to review\n`
      );
      return deps.exit(1);
    }
    // Default (skipReason === "busy" or absent): another process owns the lease
    // and no work was done — declining is correct, exit 0.
    deps.stderr(
      `review skipped: another process is already reviewing this revision — no work was done\n`
    );
    return;
  }
}
