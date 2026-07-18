import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runPullRequestReviewWatch,
  type ReviewWatchDeps,
} from "../pr-review-watch.js";
import type {
  PullRequestRevision,
  PullRequestReviewRunResult,
} from "../pr-review.js";
import type { ResolvedReviewInput } from "../pr-review-input.js";
import { ReviewInputError } from "../pr-review-input.js";
import { GitHubPrError } from "../github-pr.js";
import type { PullRequestReviewConfig } from "../review-cli.js";
import type { PullRequestReviewState } from "../pr-review-state.js";
import type { AgentRuntimeId } from "../agent-runtime.js";
import type { TierLadder } from "../model-tier.js";
import type { TokenMode } from "../tokens.js";
import type { CompressorMode } from "../context-compressor.js";

// Spy on the terminal notifiers so we can assert they fire ONLY on a terminal
// budget stop / unrecoverable failure — never on idle or recoverable cycles.
const notifyMocks = vi.hoisted(() => ({
  notifyComplete: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock("../notify.js", () => ({
  notifyComplete: notifyMocks.notifyComplete,
  notifyError: notifyMocks.notifyError,
}));

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);

const config: PullRequestReviewConfig & { watch: true } = {
  repository: "acme/widget",
  watch: true,
  watchIntervalSec: 300,
  label: "otto-review",
  reviewInput: { kind: "none" },
  output: "comment",
  githubReview: false,
};

function resolved(fingerprint = FP_A): ResolvedReviewInput {
  return { kind: "none", source: "none", content: "", fingerprint };
}

function rev(
  number: number,
  over: Partial<PullRequestRevision> = {}
): PullRequestRevision {
  return {
    repository: "acme/widget",
    number,
    url: `https://github.com/acme/widget/pull/${number}`,
    title: `PR ${number}`,
    body: "",
    author: "octocat",
    state: "OPEN",
    isDraft: false,
    labels: ["otto-review"],
    baseRefName: "main",
    baseSha: "0".repeat(40),
    headSha: HEAD_1,
    changedFiles: ["src/a.ts"],
    ...over,
  };
}

function okResult(
  revision: PullRequestRevision,
  fingerprint: string,
  over: Partial<PullRequestReviewRunResult> = {}
): PullRequestReviewRunResult {
  return {
    status: "succeeded",
    runId: "run-1",
    repository: revision.repository,
    pullRequest: revision.number,
    headSha: revision.headSha,
    inputFingerprint: fingerprint,
    costUsd: 0.1,
    outcome: "approved",
    ...over,
  };
}

function succeededState(
  revision: PullRequestRevision,
  fingerprint: string
): PullRequestReviewState {
  return {
    repository: revision.repository,
    pullRequest: revision.number,
    headSha: revision.headSha,
    inputFingerprint: fingerprint,
    status: "succeeded",
    runId: "run-1",
    outputs: {},
    attempts: 1,
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

/** Fake `sleep` that aborts the daemon after its `afterCalls`-th invocation. */
function stopSleep(controller: AbortController, afterCalls = 1) {
  let n = 0;
  return vi.fn(async (_ms: number, _signal?: AbortSignal) => {
    n += 1;
    if (n >= afterCalls) {
      controller.abort();
      const e = new Error("sleep aborted");
      e.name = "AbortError";
      throw e;
    }
  });
}

type Harness = {
  deps: Partial<ReviewWatchDeps>;
  release: ReturnType<typeof vi.fn>;
  acquireKeepAlive: ReturnType<typeof vi.fn>;
  resolveInput: ReturnType<typeof vi.fn>;
  listPullRequests: ReturnType<typeof vi.fn>;
  runRevision: ReturnType<typeof vi.fn>;
  readState: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  stderr: ReturnType<typeof vi.fn>;
  order: string[];
};

function harness(
  over: Partial<ReviewWatchDeps>,
  controller: AbortController
): Harness {
  const order: string[] = [];
  const release = vi.fn();
  const acquireKeepAlive = vi.fn(() => ({ release }));
  const resolveInput = vi.fn(() => {
    order.push("resolve");
    return resolved();
  });
  const listPullRequests = vi.fn(() => {
    order.push("list");
    return [] as PullRequestRevision[];
  });
  const runRevision = vi.fn(async () => okResult(rev(1), FP_A));
  const readState = vi.fn(() => null as PullRequestReviewState | null);
  const sleep = stopSleep(controller);
  const stderr = vi.fn();
  const deps: Partial<ReviewWatchDeps> = {
    resolveInput: resolveInput as never,
    listPullRequests: listPullRequests as never,
    runRevision: runRevision as never,
    readState: readState as never,
    sleep: sleep as never,
    acquireKeepAlive: acquireKeepAlive as never,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    stderr: stderr as never,
    ...over,
  };
  return {
    deps,
    release,
    acquireKeepAlive,
    resolveInput: (over.resolveInput as never) ?? resolveInput,
    listPullRequests: (over.listPullRequests as never) ?? listPullRequests,
    runRevision: (over.runRevision as never) ?? runRevision,
    readState: (over.readState as never) ?? readState,
    sleep: (over.sleep as never) ?? sleep,
    stderr: (over.stderr as never) ?? stderr,
    order,
  };
}

function baseOpts(
  deps: Partial<ReviewWatchDeps>,
  signal: AbortSignal,
  over: Record<string, unknown> = {}
) {
  return {
    workspaceDir: "/ws",
    packageDir: "/pkg",
    config,
    agentId: "claude" as AgentRuntimeId,
    autoSwitchOnLimit: false,
    modelRouting: false,
    tierLadder: {} as unknown as TierLadder,
    tokenMode: "off" as TokenMode,
    contextCompressor: "off" as CompressorMode,
    maxRetries: 3,
    cooldownMs: 0,
    verbose: false,
    signal,
    deps,
    ...over,
  } as Parameters<typeof runPullRequestReviewWatch>[0];
}

describe("runPullRequestReviewWatch", () => {
  beforeEach(() => {
    notifyMocks.notifyComplete.mockReset();
    notifyMocks.notifyError.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("empty queue logs idle once, sleeps the interval, and never runs a model", async () => {
    const controller = new AbortController();
    const h = harness({}, controller);
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    expect(h.runRevision).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.sleep.mock.calls[0][0]).toBe(300_000);
    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/idle/);
    expect(notifyMocks.notifyComplete).not.toHaveBeenCalled();
    expect(notifyMocks.notifyError).not.toHaveBeenCalled();
    // keepalive acquired with the review reason and released exactly once.
    expect(h.acquireKeepAlive).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "otto-review watch" })
    );
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a PR-list failure is a distinct poll failure that never reads/writes revision state", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => {
      throw new GitHubPrError("bad credentials", "auth", false, 401);
    });
    const readState = vi.fn(() => null);
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        readState: readState as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/auth/);
    expect(log).not.toMatch(/idle/);
    expect(h.readState).not.toHaveBeenCalled();
    expect(h.runRevision).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it("an input-resolution failure is a poll failure, not an empty queue, and runs no review", async () => {
    const controller = new AbortController();
    const resolveInput = vi.fn(() => {
      throw new ReviewInputError("not-found", "spec file missing");
    });
    const listPullRequests = vi.fn(() => [rev(1)]);
    const h = harness(
      {
        resolveInput: resolveInput as never,
        listPullRequests: listPullRequests as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/spec file missing/);
    expect(log).not.toMatch(/idle/);
    // resolution failed FIRST — the PR list is never even consulted.
    expect(h.listPullRequests).not.toHaveBeenCalled();
    expect(h.runRevision).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it("each poll resolves the input exactly once BEFORE state selection and passes the same snapshot to the run", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const resolveInput = vi.fn(() => {
      order.push("resolve");
      return resolved(FP_A);
    });
    const listPullRequests = vi.fn(() => {
      order.push("list");
      return [rev(1)];
    });
    // readState: runnable first time, succeeded after the run so the daemon drains.
    let ran = false;
    const readState = vi.fn(() => (ran ? succeededState(rev(1), FP_A) : null));
    const runRevision = vi.fn(async () => {
      ran = true;
      return okResult(rev(1), FP_A);
    });
    const h = harness(
      {
        resolveInput: resolveInput as never,
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        readState: readState as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    // resolve happens before list on every poll.
    expect(order[0]).toBe("resolve");
    expect(order[1]).toBe("list");
    // exactly one resolve per poll (2 polls: the run poll + the drained idle poll).
    const resolves = order.filter((o) => o === "resolve").length;
    const lists = order.filter((o) => o === "list").length;
    expect(resolves).toBe(lists);
    // the run receives the exact resolved snapshot for that poll.
    const arg = runRevision.mock.calls[0][0] as {
      reviewInput: ResolvedReviewInput;
    };
    expect(arg.reviewInput.fingerprint).toBe(FP_A);
  });

  it("only open, non-draft, exact-labelled revisions enter the queue", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [
      rev(1, { state: "CLOSED" }),
      rev(2, { isDraft: true }),
      rev(3, { labels: ["other"] }),
    ]);
    const runRevision = vi.fn(async () => okResult(rev(4), FP_A));
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));
    // none of the three ineligible PRs is reviewed → idle.
    expect(h.runRevision).not.toHaveBeenCalled();
    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/idle/);
  });

  it("processes the lowest PR number first and one revision at a time, draining before it sleeps", async () => {
    const controller = new AbortController();
    const prs = [rev(9), rev(4)];
    const listPullRequests = vi.fn(() => prs);
    const processed = new Set<number>();
    const runRevision = vi.fn(async (o: { revision: PullRequestRevision }) => {
      processed.add(o.revision.number);
      return okResult(o.revision, FP_A);
    });
    const readState = vi.fn(
      (_ws: string, _repo: string, pr: number, _head: string, _fp: string) =>
        processed.has(pr) ? succeededState(rev(pr), FP_A) : null
    );
    const sleep = stopSleep(controller); // aborts on the first sleep
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        readState: readState as never,
        sleep: sleep as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    // Both PRs reviewed, PR 4 before PR 9, with NO sleep between them.
    expect(
      runRevision.mock.calls.map(
        (c) => (c[0] as { revision: PullRequestRevision }).revision.number
      )
    ).toEqual([4, 9]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("skips an already-successful composite identity but picks up a new head SHA", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1, { headSha: HEAD_2 })]);
    const runRevision = vi.fn(async () =>
      okResult(rev(1, { headSha: HEAD_2 }), FP_A)
    );
    // The OLD head is succeeded; the new head has no state → runnable.
    const readState = vi.fn(
      (_ws: string, _repo: string, _pr: number, head: string, _fp: string) =>
        head === HEAD_1 ? succeededState(rev(1), FP_A) : null
    );
    let ran = false;
    runRevision.mockImplementation(async () => {
      ran = true;
      return okResult(rev(1, { headSha: HEAD_2 }), FP_A);
    });
    readState.mockImplementation(
      (_ws: string, _repo: string, _pr: number, head: string, _fp: string) => {
        if (head === HEAD_2 && ran)
          return succeededState(rev(1, { headSha: HEAD_2 }), FP_A);
        return head === HEAD_1 ? succeededState(rev(1), FP_A) : null;
      }
    );
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        readState: readState as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));
    expect(runRevision).toHaveBeenCalledTimes(1);
  });

  it("a changed input fingerprint is treated as new work", async () => {
    const controller = new AbortController();
    // Different fingerprint each poll → the succeeded state (for FP_A) never
    // matches, so the PR is runnable again under FP_B.
    const resolveInput = vi
      .fn()
      .mockReturnValueOnce(resolved(FP_B))
      .mockReturnValue(resolved(FP_B));
    const listPullRequests = vi.fn(() => [rev(1)]);
    let ran = false;
    const runRevision = vi.fn(async () => {
      ran = true;
      return okResult(rev(1), FP_B);
    });
    const readState = vi.fn(
      (_ws: string, _repo: string, _pr: number, _head: string, fp: string) => {
        if (fp === FP_A) return succeededState(rev(1), FP_A);
        if (fp === FP_B && ran) return succeededState(rev(1), FP_B);
        return null;
      }
    );
    const h = harness(
      {
        resolveInput: resolveInput as never,
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        readState: readState as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));
    expect(runRevision).toHaveBeenCalledTimes(1);
    expect(
      (runRevision.mock.calls[0][0] as { reviewInput: ResolvedReviewInput })
        .reviewInput.fingerprint
    ).toBe(FP_B);
  });

  it("a retryable failure is skipped until nextRetryAt", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1)]);
    const readState = vi.fn(
      (): PullRequestReviewState => ({
        ...succeededState(rev(1), FP_A),
        status: "publish-failed",
        retryable: true,
        nextRetryAt: "2026-07-18T01:00:00.000Z", // one hour in the FUTURE
      })
    );
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        readState: readState as never,
        now: (() => new Date("2026-07-18T00:00:00.000Z")) as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));
    // not yet eligible → idle, no review.
    expect(h.runRevision).not.toHaveBeenCalled();
    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/idle/);
  });

  it("a thrown revision is caught as a bounded failure and does not kill the daemon", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1)]);
    const runRevision = vi.fn(async () => {
      throw new Error("resume-path re-query blew up");
    });
    // sleep aborts on its FIRST call — the daemon must reach a sleep, proving it
    // survived the throw rather than crashing out of the loop.
    const sleep = stopSleep(controller, 1);
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        sleep: sleep as never,
      },
      controller
    );
    await expect(
      runPullRequestReviewWatch(baseOpts(h.deps, controller.signal))
    ).resolves.toBeUndefined();
    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/resume-path re-query blew up/);
    expect(sleep).toHaveBeenCalled();
    // a caught revision throw is NOT an unrecoverable daemon failure.
    expect(notifyMocks.notifyError).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("cumulative model cost stops the daemon at budget before starting another review", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1), rev(2)]);
    const runRevision = vi.fn(async (o: { revision: PullRequestRevision }) =>
      okResult(o.revision, FP_A, { costUsd: 10 })
    );
    const readState = vi.fn(() => null);
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        readState: readState as never,
      },
      controller
    );
    await runPullRequestReviewWatch(
      baseOpts(h.deps, controller.signal, { budgetUsd: 5, notify: true })
    );
    // one review ran, then the budget gate stopped the daemon before a second.
    expect(runRevision).toHaveBeenCalledTimes(1);
    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/budget/);
    expect(notifyMocks.notifyComplete).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("abort cancels the active review, performs no later poll, and releases keepalive once", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1)]);
    let seenSignal: AbortSignal | undefined;
    const runRevision = vi.fn(async (o: { signal?: AbortSignal }) => {
      // Abort mid-run (e.g. SIGINT). The run receives the aborted signal so it
      // can finalize evidence + release its own claim before returning.
      controller.abort();
      seenSignal = o.signal;
      return okResult(rev(1), FP_A, { status: "cancelled" });
    });
    const sleep = vi.fn(async () => {});
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        runRevision: runRevision as never,
        sleep: sleep as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    expect(runRevision).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
    // no re-poll after abort.
    expect(listPullRequests).toHaveBeenCalledTimes(1);
    // and it never slept after the abort.
    expect(sleep).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("does not hot-spin when a run leaves the same identity runnable — it sleeps before re-selecting", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1)]);
    // The run returns a non-terminal outcome and the persisted state stays
    // runnable (cancelled ⇒ isStateRunnable === true), so the SAME composite
    // identity is re-selected next poll.
    const readState = vi.fn(
      (): PullRequestReviewState => ({
        ...succeededState(rev(1), FP_A),
        status: "cancelled",
      })
    );
    let runs = 0;
    const runRevision = vi.fn(async () => {
      runs += 1;
      // Safety net: if the (buggy) daemon tight-loops with no sleep, bound it so
      // the test terminates instead of hanging.
      if (runs >= 5) controller.abort();
      return okResult(rev(1), FP_A, { status: "cancelled" });
    });
    const sleep = stopSleep(controller, 1); // aborts on the FIRST sleep
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        readState: readState as never,
        runRevision: runRevision as never,
        sleep: sleep as never,
      },
      controller
    );
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));

    // The identity is run once, then the daemon SLEEPS rather than re-selecting
    // and repaying for it back-to-back.
    expect(runRevision).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("a state-read / selection throw is caught as a bounded poll failure and does not kill the daemon", async () => {
    const controller = new AbortController();
    const listPullRequests = vi.fn(() => [rev(1)]);
    const readState = vi.fn(() => {
      throw new Error("corrupt review-state file");
    });
    const sleep = stopSleep(controller, 1);
    const h = harness(
      {
        listPullRequests: listPullRequests as never,
        readState: readState as never,
        sleep: sleep as never,
      },
      controller
    );
    await expect(
      runPullRequestReviewWatch(baseOpts(h.deps, controller.signal))
    ).resolves.toBeUndefined();

    const log = h.stderr.mock.calls.map((c) => c[0]).join("");
    expect(log).toMatch(/corrupt review-state file/);
    expect(log).toMatch(/poll failure/);
    expect(h.runRevision).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    // a recoverable poll failure is NOT an unrecoverable daemon failure.
    expect(notifyMocks.notifyError).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("an already-aborted signal performs no poll at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({}, controller);
    await runPullRequestReviewWatch(baseOpts(h.deps, controller.signal));
    expect(h.listPullRequests).not.toHaveBeenCalled();
    expect(h.runRevision).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
