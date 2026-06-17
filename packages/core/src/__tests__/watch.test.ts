import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../stages.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  runLoop: vi.fn(),
  sleep: vi.fn(),
  pollIssues: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock("../keepalive.js", () => ({ acquire: mocks.acquire }));
vi.mock("../loop.js", () => ({ runLoop: mocks.runLoop }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));

import { runWatch, pollOpenIssues, pollLinearIssues } from "../watch.js";
import { LinearApiError, type LinearAuth } from "../linear-api.js";

const stage: Stage = { name: "ghafk-implementer", template: "ghafk.md" };
const baseOpts = (over = {}) => ({
  stages: [stage] as [Stage],
  iterations: 3,
  workspaceDir: "/ws",
  packageDir: "/pkg",
  watchIntervalSec: 60,
  watchLabel: "otto",
  pollIssues: mocks.pollIssues,
  ...over,
});

/** Stop the daemon loop after `n` polls by aborting the sleep. */
const abortAfter = (n: number) => {
  let polls = 0;
  return () => {
    polls++;
    return polls >= n
      ? Promise.reject(Object.assign(new Error("stop"), { name: "AbortError" }))
      : Promise.resolve();
  };
};

describe("pollOpenIssues", () => {
  // NB: deliberately no mockReset() on execFileSync here — under vitest v4,
  // resetting a mock and then giving it a throwing implementation surfaces the
  // throw as an unhandled error and fails the test. Each case sets its own
  // implementation, which overrides the prior one, so a reset isn't needed.
  it("returns ok + count on success", () => {
    mocks.execFileSync.mockReturnValue('[{"number":1},{"number":2}]');
    expect(pollOpenIssues("otto", "/ws")).toEqual({ ok: true, count: 2 });
  });

  it("classifies an auth failure (auth: true)", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
      });
    });
    const r = pollOpenIssues("otto", "/ws");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.auth).toBe(true);
  });

  it("classifies a non-auth failure (auth: false)", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "error connecting to api.github.com: network is unreachable\n",
      });
    });
    const r = pollOpenIssues("otto", "/ws");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.auth).toBe(false);
  });

  it("scopes the poll to --repo when a repo is given", () => {
    mocks.execFileSync.mockReturnValue("[]");
    pollOpenIssues("otto", "/ws", "acme/web");
    const call = mocks.execFileSync.mock.calls.at(-1);
    expect(call?.[0]).toBe("gh");
    expect(call?.[1]).toEqual(expect.arrayContaining(["--repo", "acme/web"]));
  });

  it("omits --repo when no repo is given (workspace default)", () => {
    mocks.execFileSync.mockReturnValue("[]");
    pollOpenIssues("otto", "/ws");
    const call = mocks.execFileSync.mock.calls.at(-1);
    expect(call?.[1]).not.toContain("--repo");
  });
});

describe("pollLinearIssues", () => {
  const auth: LinearAuth = { token: "lin_key", source: "OTTO_LINEAR_API_KEY" };

  it("returns ok + count from listIssues", async () => {
    const r = await pollLinearIssues({
      label: "otto",
      resolveAuth: () => auth,
      makeClient: () => ({ listIssues: async () => [{ id: "1" }, { id: "2" }] as any }),
    });
    expect(r).toEqual({ ok: true, count: 2 });
  });

  it("classifies missing auth as an auth failure (no network call)", async () => {
    let made = false;
    const r = await pollLinearIssues({
      label: "otto",
      resolveAuth: () => null,
      makeClient: () => {
        made = true;
        return { listIssues: async () => [] };
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.auth).toBe(true);
      expect(r.detail).toMatch(/otto-linear-auth login/);
    }
    expect(made).toBe(false);
  });

  it("classifies a LinearApiError auth kind as an auth failure", async () => {
    const r = await pollLinearIssues({
      label: "otto",
      resolveAuth: () => auth,
      makeClient: () => ({
        listIssues: async () => {
          throw new LinearApiError("Linear GraphQL error: 401", "auth", 401);
        },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.auth).toBe(true);
      expect(r.detail).toMatch(/401/);
    }
  });

  it("classifies a non-auth LinearApiError as a poll failure", async () => {
    const r = await pollLinearIssues({
      label: "otto",
      resolveAuth: () => auth,
      makeClient: () => ({
        listIssues: async () => {
          throw new LinearApiError("Linear request failed: down", "network");
        },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.auth).toBe(false);
  });

  it("classifies an unexpected error as a poll failure", async () => {
    const r = await pollLinearIssues({
      label: "otto",
      resolveAuth: () => auth,
      makeClient: () => ({
        listIssues: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.auth).toBe(false);
  });

  it("forwards label + team to listIssues", async () => {
    let seen: unknown;
    await pollLinearIssues({
      label: "ops",
      team: "ENG",
      resolveAuth: () => auth,
      makeClient: () => ({
        listIssues: async (o: unknown) => {
          seen = o;
          return [];
        },
      }),
    });
    expect(seen).toMatchObject({ label: "ops", team: "ENG" });
  });
});

describe("runWatch", () => {
  let stderr: string[];
  beforeEach(() => {
    for (const m of Object.values(mocks)) (m as any).mockReset?.();
    mocks.acquire.mockReturnValue({ release: mocks.release });
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      stderr.push(String(s));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs the loop when issues exist and stops on cumulative budget", async () => {
    mocks.pollIssues.mockReturnValue({ ok: true, count: 1 });
    mocks.runLoop.mockResolvedValue({ costUsd: 6, sentinelHit: true });
    mocks.sleep.mockResolvedValue(undefined);
    await runWatch(baseOpts({ budgetUsd: 11 }));
    // run1 cum 6 (<11) → run2 cum 12 (>=11) → stop before run3
    expect(mocks.runLoop).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("forwards maxRetries + reviewLenses (and remaining budget) into runLoop", async () => {
    mocks.pollIssues.mockReturnValue({ ok: true, count: 1 });
    mocks.runLoop.mockResolvedValue({ costUsd: 3, sentinelHit: true });
    mocks.sleep.mockResolvedValue(undefined);
    await runWatch(
      baseOpts({
        budgetUsd: 5,
        maxRetries: 0,
        reviewLenses: ["correctness"],
      })
    );
    // first run gets the full budget remaining + the loop flags that --watch must honor
    expect(mocks.runLoop).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        maxRetries: 0,
        reviewLenses: ["correctness"],
        budgetUsd: 5,
        noKeepAlive: true,
      })
    );
  });

  it("idle: no open issues prints a distinct idle line and keeps polling", async () => {
    mocks.pollIssues.mockReturnValue({ ok: true, count: 0 });
    mocks.sleep.mockImplementation(abortAfter(3));
    await runWatch(baseOpts()).catch(() => {});
    expect(mocks.runLoop).not.toHaveBeenCalled();
    const text = stderr.join("");
    expect(text).toMatch(/no open issues/i);
    expect(text).not.toMatch(/failed|auth/i);
  });

  it("idle: prints the idle line once across repeated empty polls (no log-spam)", async () => {
    mocks.pollIssues.mockReturnValue({ ok: true, count: 0 });
    mocks.sleep.mockImplementation(abortAfter(5));
    await runWatch(baseOpts()).catch(() => {});
    const idleLines = stderr
      .join("")
      .split("\n")
      .filter((l) => /no open issues/i.test(l));
    expect(idleLines).toHaveLength(1);
  });

  it("auth failure: prints a distinct gh-auth hint, not an idle line", async () => {
    mocks.pollIssues.mockReturnValue({ ok: false, auth: true, detail: "" });
    mocks.sleep.mockImplementation(abortAfter(2));
    await runWatch(baseOpts()).catch(() => {});
    expect(mocks.runLoop).not.toHaveBeenCalled();
    const text = stderr.join("");
    expect(text).toMatch(/gh auth login/i);
    expect(text).not.toMatch(/no open issues/i);
  });

  it("auth failure: surfaces poll.detail so a misclassified error isn't swallowed", async () => {
    mocks.pollIssues.mockReturnValue({
      ok: false,
      auth: true,
      detail: "HTTP 401: Bad credentials",
    });
    mocks.sleep.mockImplementation(abortAfter(2));
    await runWatch(baseOpts()).catch(() => {});
    const text = stderr.join("");
    expect(text).toMatch(/gh auth login/i);
    expect(text).toMatch(/HTTP 401: Bad credentials/);
  });

  it("provider: a Linear auth failure prints the otto-linear-auth hint, not the gh one", async () => {
    mocks.pollIssues.mockReturnValue({
      ok: false,
      auth: true,
      detail: "Linear GraphQL error: 401",
    });
    mocks.sleep.mockImplementation(abortAfter(2));
    await runWatch(
      baseOpts({
        provider: { name: "Linear", authCmd: "otto-linear-auth login" },
      })
    ).catch(() => {});
    const text = stderr.join("");
    expect(text).toMatch(/Linear not authenticated/);
    expect(text).toMatch(/otto-linear-auth login/);
    expect(text).not.toMatch(/gh auth login/);
    expect(text).not.toMatch(/no open issues/i);
  });

  it("scope: forwards the github repo to the poller and names it in the poll lines", async () => {
    mocks.pollIssues.mockReturnValue({ ok: true, count: 0 });
    mocks.sleep.mockImplementation(abortAfter(2));
    await runWatch(
      baseOpts({ scope: { provider: "github", owner: "acme", repo: "web" } })
    ).catch(() => {});
    expect(mocks.pollIssues).toHaveBeenCalledWith("otto", "/ws", "acme/web");
    expect(stderr.join("")).toMatch(/github acme\/web/);
  });

  it("poll failure: prints a poll-failed line distinct from idle", async () => {
    mocks.pollIssues.mockReturnValue({
      ok: false,
      auth: false,
      detail: "network is unreachable",
    });
    mocks.sleep.mockImplementation(abortAfter(2));
    await runWatch(baseOpts()).catch(() => {});
    expect(mocks.runLoop).not.toHaveBeenCalled();
    const text = stderr.join("");
    expect(text).toMatch(/poll failed/i);
    expect(text).toMatch(/network is unreachable/);
    expect(text).not.toMatch(/no open issues/i);
  });
});
