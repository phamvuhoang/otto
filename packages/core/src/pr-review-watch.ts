/**
 * P32 Slice 2 — the sequential labelled-PR watch daemon. `otto-review --watch`
 * continuously polls one repository's open, labelled pull requests and reviews
 * each unseen composite identity `(headSha, inputFingerprint)` EXACTLY once,
 * publishing the marker-owned summary comment (Task 12) via the same one-shot
 * pipeline used by a `--pr` run.
 *
 * Operationally it mirrors the issue-watch daemon (`watch.ts`): it acquires a
 * keep-alive wake-lock, distinguishes an *idle* queue (no eligible revision)
 * from a *poll failure* (auth/permission actionable; rate-limit/network use the
 * pipeline's own bounded backoff and never mark a revision processed), sleeps
 * the configured interval only when no work ran, and honours a budget /
 * abort / shutdown across the daemon lifetime.
 *
 * Two invariants make it safe for unattended use:
 *
 *  1. **One revision at a time, drain before sleeping.** After a completed item
 *     the daemon IMMEDIATELY re-polls (re-resolving the input and re-listing
 *     PRs) until no runnable revision remains, then sleeps.
 *  2. **A single revision's exception must never kill the daemon.** Every
 *     `runPullRequestReview` call is wrapped: a throw (including a known
 *     resume-path re-query throw) is logged as a bounded revision failure and
 *     the loop continues.
 *
 * The per-poll review input is resolved FRESH on every poll: an edited
 * issue/file/changed prompt yields a new fingerprint = new work, and a
 * source-resolution failure is a POLL FAILURE — never an empty queue and never
 * a processed revision.
 *
 * Every external seam (input resolution, PR listing, the pipeline, state reads,
 * sleep, keep-alive, clock, stderr) is injectable so the whole loop is
 * unit-testable with no real GitHub, model, or wall-clock delay.
 */
import type { AgentRuntimeId } from "./agent-runtime.js";
import { acquire } from "./keepalive.js";
import { createGitHubPrClient, GitHubPrError } from "./github-pr.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep } from "./pacing.js";
import {
  resolveReviewInput,
  ReviewInputError,
  type ResolvedReviewInput,
} from "./pr-review-input.js";
import {
  ineligibleReason,
  runPullRequestReview,
  type PullRequestRevision,
} from "./pr-review.js";
import { isStateRunnable, readReviewState } from "./pr-review-state.js";
import type { PullRequestReviewConfig } from "./review-cli.js";
import type { TierLadder } from "./model-tier.js";
import type { TokenMode } from "./tokens.js";
import type { CompressorMode } from "./context-compressor.js";

/**
 * Injectable seams for {@link runPullRequestReviewWatch}. `resolveInput` is a
 * pre-bound closure (no args) so the daemon re-runs the exact same resolution
 * every poll and a fresh source snapshot is produced each time.
 */
export type ReviewWatchDeps = {
  resolveInput: () => ResolvedReviewInput;
  listPullRequests: (
    repository: string,
    label: string
  ) => PullRequestRevision[];
  runRevision: typeof runPullRequestReview;
  readState: typeof readReviewState;
  sleep: typeof sleep;
  acquireKeepAlive: typeof acquire;
  now: () => Date;
  stderr: (text: string) => void;
};

/**
 * Run the labelled-PR watch daemon until the abort signal fires, a budget is
 * reached, or an unrecoverable failure occurs. Never resolves with a value; a
 * caught revision throw / poll failure keeps the loop alive.
 */
export async function runPullRequestReviewWatch(opts: {
  workspaceDir: string;
  packageDir: string;
  config: PullRequestReviewConfig & { watch: true };
  agentId: AgentRuntimeId;
  fallbackAgentId?: AgentRuntimeId;
  autoSwitchOnLimit: boolean;
  modelRouting: boolean;
  tierLadder: TierLadder;
  tokenMode: TokenMode;
  contextCompressor: CompressorMode;
  maxRetries: number;
  cooldownMs: number;
  budgetUsd?: number;
  notify?: boolean;
  verbose: boolean;
  signal?: AbortSignal;
  deps?: Partial<ReviewWatchDeps>;
}): Promise<void> {
  const { config } = opts;
  const repository = config.repository;
  const label = config.label;
  const intervalMs = config.watchIntervalSec * 1000;

  // A shared GitHub client backs the default resolveInput/listPullRequests so a
  // real run needs no injection; tests replace both seams outright.
  const github = createGitHubPrClient({ cwd: opts.workspaceDir });
  const deps: ReviewWatchDeps = {
    resolveInput:
      opts.deps?.resolveInput ??
      (() =>
        resolveReviewInput({
          workspaceDir: opts.workspaceDir,
          repository,
          request: config.reviewInput,
          github,
        })),
    listPullRequests:
      opts.deps?.listPullRequests ??
      ((repo, lbl) => github.listPullRequests(repo, lbl)),
    runRevision: opts.deps?.runRevision ?? runPullRequestReview,
    readState: opts.deps?.readState ?? readReviewState,
    sleep: opts.deps?.sleep ?? sleep,
    acquireKeepAlive: opts.deps?.acquireKeepAlive ?? acquire,
    now: opts.deps?.now ?? (() => new Date()),
    stderr: opts.deps?.stderr ?? ((t) => void process.stderr.write(t)),
  };

  const notify = opts.notify ?? false;

  // The daemon abort controller is aborted by the caller's signal OR a POSIX
  // shutdown signal. It — not a hard process.exit — drives shutdown so the
  // active review can finalize evidence + release its claim before we unwind.
  const daemonAbort = new AbortController();
  const external = opts.signal;
  const onExternalAbort = (): void => daemonAbort.abort();
  if (external) {
    if (external.aborted) daemonAbort.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const onShutdown = (): void => daemonAbort.abort();
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  const releaser = deps.acquireKeepAlive({ reason: "otto-review watch" });
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };

  /** Sleep the interval; a shutdown abort turns the wait into a clean exit. */
  const sleepInterval = async (): Promise<void> => {
    try {
      await deps.sleep(intervalMs, daemonAbort.signal);
    } catch {
      // AbortError while sleeping — the loop-top guard will break.
    }
  };

  /** First open/non-draft/labelled + composite-runnable revision, PR asc. */
  const selectRunnable = (
    prs: PullRequestRevision[],
    resolved: ResolvedReviewInput
  ): PullRequestRevision | null => {
    const eligible = prs
      .filter((pr) => ineligibleReason(pr, label) === null)
      .sort((a, b) => a.number - b.number);
    const at = deps.now();
    for (const pr of eligible) {
      const state = deps.readState(
        opts.workspaceDir,
        repository,
        pr.number,
        pr.headSha,
        resolved.fingerprint
      );
      if (isStateRunnable(state, at)) return pr;
    }
    return null;
  };

  deps.stderr(
    `watching ${repository} label:${label} every ${config.watchIntervalSec}s\n`
  );

  let cumulativeCost = 0;
  // Track idle state so the "no eligible PR" line prints only on the
  // busy→idle transition — an overnight watch must not flood the log.
  let wasIdle = false;

  try {
    for (;;) {
      if (daemonAbort.signal.aborted) return;

      // Budget gate BEFORE selecting/starting another review.
      if (opts.budgetUsd != null && cumulativeCost >= opts.budgetUsd) {
        deps.stderr(
          `watch budget reached — $${cumulativeCost.toFixed(2)} ≥ $${opts.budgetUsd.toFixed(2)}, stopping\n`
        );
        if (notify) notifyComplete(0, false);
        return;
      }

      // 1. Resolve the review input FIRST. A resolution failure is a poll
      //    failure (auth/validation/etc.), not an empty queue — retry next poll.
      let resolved: ResolvedReviewInput;
      try {
        resolved = deps.resolveInput();
      } catch (err) {
        wasIdle = false;
        logInputFailure(deps.stderr, err);
        await sleepInterval();
        continue;
      }

      // 2. List the labelled PRs. A list failure is likewise a poll failure.
      let prs: PullRequestRevision[];
      try {
        prs = deps.listPullRequests(repository, label);
      } catch (err) {
        wasIdle = false;
        logPollFailure(deps.stderr, err);
        await sleepInterval();
        continue;
      }

      // 3. Select the first runnable composite identity for THIS snapshot.
      const candidate = selectRunnable(prs, resolved);
      if (!candidate) {
        if (!wasIdle) {
          wasIdle = true;
          deps.stderr(
            `no eligible pull request labelled ${label} — idle, next poll in ${config.watchIntervalSec}s\n`
          );
        }
        await sleepInterval();
        continue;
      }
      wasIdle = false;

      // 4. Review exactly one revision. A throw here — including a known
      //    resume-path re-query throw — is a BOUNDED revision failure: log it
      //    and continue the loop. It must never escape and kill the daemon.
      let cost = 0;
      try {
        const result = await deps.runRevision({
          workspaceDir: opts.workspaceDir,
          packageDir: opts.packageDir,
          revision: candidate,
          reviewInput: resolved,
          config,
          agentId: opts.agentId,
          fallbackAgentId: opts.fallbackAgentId,
          autoSwitchOnLimit: opts.autoSwitchOnLimit,
          modelRouting: opts.modelRouting,
          tierLadder: opts.tierLadder,
          tokenMode: opts.tokenMode,
          contextCompressor: opts.contextCompressor,
          maxRetries: opts.maxRetries,
          cooldownMs: opts.cooldownMs,
          budgetUsd:
            opts.budgetUsd != null
              ? opts.budgetUsd - cumulativeCost
              : undefined,
          verbose: opts.verbose,
          signal: daemonAbort.signal,
          deps: { github },
        });
        cost = result.costUsd;
        deps.stderr(
          `reviewed ${repository}#${candidate.number} (${result.status}) — cumulative $${(cumulativeCost + cost).toFixed(2)}\n`
        );
      } catch (err) {
        deps.stderr(
          `review of ${repository}#${candidate.number} failed: ${(err as Error).message} — continuing\n`
        );
        // A caught revision failure is recoverable: back off one interval so a
        // transient fault clears, then re-poll (state is unchanged).
        await sleepInterval();
        continue;
      }
      cumulativeCost += cost;

      // On shutdown the active run already finalized/released; do not re-poll.
      if (daemonAbort.signal.aborted) return;
      // Otherwise IMMEDIATELY re-poll (no sleep) until the queue is drained.
    }
  } catch (err) {
    // An unexpected escape from the loop scaffolding itself is an unrecoverable
    // daemon failure — surface it once (never on idle/recoverable cycles).
    deps.stderr(`watch daemon failed: ${(err as Error).message}\n`);
    if (notify)
      notifyError(`otto-review watch stopped: ${(err as Error).message}`);
    throw err;
  } finally {
    process.off("SIGINT", onShutdown);
    process.off("SIGTERM", onShutdown);
    if (external) external.removeEventListener("abort", onExternalAbort);
    releaseOnce();
  }
}

/** Log a review-input resolution failure as a distinct, actionable poll failure. */
function logInputFailure(stderr: (t: string) => void, err: unknown): void {
  if (err instanceof ReviewInputError) {
    stderr(
      `review-input resolution failed (${err.kind}) — poll failure, not an empty queue: ${err.message}\n`
    );
    return;
  }
  stderr(
    `review-input resolution failed — poll failure, not an empty queue: ${(err as Error).message}\n`
  );
}

/** Log a PR-list poll failure with its classification + a remedy where actionable. */
function logPollFailure(stderr: (t: string) => void, err: unknown): void {
  if (err instanceof GitHubPrError) {
    const remedy =
      err.kind === "auth"
        ? " — run 'gh auth login'"
        : err.kind === "permission"
          ? " — check the token's repo permissions"
          : "";
    stderr(
      `pull-request poll failed (${err.kind}${err.retryable ? ", retryable" : ""})${remedy}: ${err.message}\n`
    );
    return;
  }
  stderr(`pull-request poll failed: ${(err as Error).message}\n`);
}
