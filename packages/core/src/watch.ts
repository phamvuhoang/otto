import { execFileSync } from "node:child_process";
import type { AgentRuntimeId } from "./agent-runtime.js";
import { acquire, type Releaser } from "./keepalive.js";
import {
  createLinearClient,
  resolveLinearAuth,
  LinearApiError,
  type LinearAuth,
  type LinearClient,
} from "./linear-api.js";
import { runLoop } from "./loop.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep } from "./pacing.js";
import { describeScope, type WorkScope } from "./task-key.js";
import {
  bold,
  dim,
  greenOut,
  boldOut,
  dimOut,
  SYM_OUT,
  USE_COLOR,
} from "./stream-render.js";
import type { Stage } from "./stages.js";
import type { TokenMode } from "./tokens.js";

/**
 * Outcome of one issue poll. Distinguishes a real idle queue (`ok` with
 * `count: 0`) from a broken poll (`!ok`) so the daemon can say *why* it is not
 * working — an empty queue and a failed/unauthenticated `gh` are very different
 * states for a maintainer reading the log.
 */
export type PollResult =
  | { ok: true; count: number }
  | { ok: false; auth: boolean; detail: string };

/**
 * Poll open issues carrying `label`, via gh. Never throws. When `repo`
 * (`owner/name`) is given the poll is confined to that repository (watch
 * scoping) instead of the workspace's default repo.
 */
export function pollOpenIssues(
  label: string,
  cwd: string,
  repo?: string
): PollResult {
  try {
    // execFileSync (no shell) so `label`/`repo` are passed as literal argv
    // entries — a value like `$(rm -rf ~)` can never be shell-evaluated. See
    // SECURITY.md. stderr is piped (not ignored) so failures can be classified.
    const out = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
        ...(repo ? ["--repo", repo] : []),
        "--json",
        "number",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const arr = JSON.parse(out) as unknown[];
    return { ok: true, count: Array.isArray(arr) ? arr.length : 0 };
  } catch (err) {
    const stderr = String(
      (err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? ""
    );
    // `gh` prints an auth hint ("gh auth login" / "not logged" / 401) when the
    // user is unauthenticated — treat those as auth failures, everything else
    // (network, gh missing, malformed output) as a generic poll failure.
    const auth =
      /auth login|not logged|unauthenticated|credential|\b401\b/i.test(stderr);
    const detail =
      stderr
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) ?? "";
    return { ok: false, auth, detail };
  }
}

/**
 * Injectable deps for {@link pollLinearIssues}, so poll classification is
 * unit-testable without a real credential file or network. Auth is re-resolved
 * each poll (default `resolveLinearAuth`) so a mid-watch re-login is picked up.
 */
export type LinearPollDeps = {
  label: string;
  team?: string;
  project?: string;
  limit?: number;
  /** Resolve the Linear credential; defaults to env/file precedence. */
  resolveAuth?: () => LinearAuth | null;
  /** Build a client from a token; defaults to the real GraphQL client. */
  makeClient?: (token: string) => Pick<LinearClient, "listIssues">;
};

/**
 * Poll open Linear issues carrying `label` (count only, no comments). Never
 * throws — mirrors {@link pollOpenIssues}. A missing credential or a Linear
 * `auth`-kind error is reported as `auth: true` so the daemon can print a
 * re-login hint distinctly from a transient request/network failure.
 */
export async function pollLinearIssues(
  deps: LinearPollDeps
): Promise<PollResult> {
  const auth = (deps.resolveAuth ?? (() => resolveLinearAuth()))();
  if (!auth) {
    return {
      ok: false,
      auth: true,
      detail: "no Linear API key — run 'otto-linear-auth login'",
    };
  }
  try {
    const client = (
      deps.makeClient ?? ((t: string) => createLinearClient({ token: t }))
    )(auth.token);
    const issues = await client.listIssues({
      label: deps.label,
      team: deps.team,
      project: deps.project,
      limit: deps.limit ?? 50,
    });
    return { ok: true, count: issues.length };
  } catch (err) {
    if (err instanceof LinearApiError) {
      return { ok: false, auth: err.kind === "auth", detail: err.message };
    }
    return { ok: false, auth: false, detail: (err as Error).message };
  }
}

/**
 * Provider-specific bits of the watch UX: the noun used in poll lines and the
 * command that re-authenticates. Defaults to GitHub's `gh`.
 */
export type WatchProvider = { name: string; authCmd: string };

const GH_PROVIDER: WatchProvider = { name: "gh", authCmd: "gh auth login" };

export type RunWatchOptions = {
  stages: [Stage, ...Stage[]];
  iterations: number;
  workspaceDir: string;
  packageDir: string;
  watchIntervalSec: number;
  watchLabel: string;
  budgetUsd?: number;
  cooldownMs?: number;
  tokenMode?: TokenMode;
  maxRetries?: number;
  reviewLenses?: string[];
  notify?: boolean;
  bin?: string;
  cliVersion?: string;
  /**
   * Poller for open labelled issues. Defaults to the gh poller; otto-linear-afk
   * passes a Linear poller. May be async. Injectable for tests too. `repo` is
   * the resolved GitHub scope (`owner/name`) or undefined; the Linear poller
   * ignores it.
   */
  pollIssues?: (
    label: string,
    cwd: string,
    repo?: string
  ) => PollResult | Promise<PollResult>;
  /** Provider-specific poll/auth messaging; defaults to gh. */
  provider?: WatchProvider;
  /**
   * Resolved work scope this daemon is confined to (e.g. github owner/name).
   * Named in the poll lines and used to derive the gh `--repo` poll filter so
   * watch never picks up issues from outside the scope.
   */
  scope?: WorkScope;
  /** Active agent runtime id, threaded into each loop. Default "claude". */
  agentId?: AgentRuntimeId;
  /** Active runtime display name, shown in the per-run banner. Default "Claude Code". */
  agentDisplayName?: string;
  /**
   * Multi-target watch: several GitHub scopes the daemon rotates through. When
   * set, each cycle polls every scope, runs one loop for the first scope with
   * work (confining `OTTO_GITHUB_REPO` to it), then returns to polling all. A
   * failed poll for one scope never blocks the others. Falls back to `scope`
   * (or the workspace default) when omitted.
   */
  scopes?: WorkScope[];
};

export async function runWatch(opts: RunWatchOptions): Promise<void> {
  const {
    stages,
    iterations,
    workspaceDir,
    packageDir,
    watchIntervalSec,
    watchLabel,
    budgetUsd,
    cooldownMs,
    tokenMode = "off",
    maxRetries,
    reviewLenses,
    notify = false,
    bin = "otto-ghafk",
    pollIssues = pollOpenIssues,
    provider = GH_PROVIDER,
    scope,
    scopes,
  } = opts;

  // The scopes this daemon rotates through each cycle. Multi-target watch
  // passes `scopes`; otherwise a single `scope` (or the workspace default,
  // represented by a lone `undefined`).
  const scopeList: (WorkScope | undefined)[] =
    scopes && scopes.length > 0 ? scopes : [scope];
  // Derive the gh `--repo` filter from a github scope; other providers (Linear)
  // carry their scope in the label/team the poller already honors.
  const ghRepoOf = (s?: WorkScope): string | undefined =>
    s?.provider === "github" && s.owner && s.repo
      ? `${s.owner}/${s.repo}`
      : undefined;
  // The Linear project for a scope. Unlike github (which gets a poll `--repo`
  // arg), the Linear poller reads OTTO_LINEAR_PROJECT from the env, so the
  // daemon pins it before each poll/run to confine that scope.
  const linearProjectOf = (s?: WorkScope): string | undefined =>
    s?.provider === "linear" && s.project ? s.project : undefined;
  // Human-readable scope prefix for a poll line (e.g. "github acme/web ").
  const labelOf = (s?: WorkScope): string => (s ? `${describeScope(s)} ` : "");
  // The banner names every scope so a maintainer sees the exact watch surface.
  const bannerScope = scopeList
    .filter((s): s is WorkScope => !!s)
    .map(describeScope)
    .join(", ");
  const scopeLabel = bannerScope ? `${bannerScope} ` : "";

  const releaser: Releaser = acquire({ reason: `${bin} watch` });
  let released = false;
  const releaseOnce = (): void => {
    if (!released) {
      released = true;
      releaser.release();
    }
  };
  const daemonAbort = new AbortController();

  const onSig = (code: number) => (): void => {
    daemonAbort.abort();
    if (notify) notifyError(`watch stopped (signal)`);
    releaseOnce();
    process.exit(code);
  };
  const onSigint = onSig(130);
  const onSigterm = onSig(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  process.stderr.write(
    `${USE_COLOR ? dim("watching") + " " + bold(`${scopeLabel}label:${watchLabel} every ${watchIntervalSec}s`) : `watching ${scopeLabel}label:${watchLabel} every ${watchIntervalSec}s`}\n`
  );

  let cumulativeCost = 0;
  // Track idle state so the "no open issues" line prints only on the
  // idle→busy→idle transition, not on every empty poll — otherwise an
  // overnight watch floods the detached log with ~1 identical line per poll
  // and buries the auth/poll-failure signal this is built to surface.
  let wasIdle = false;
  try {
    for (;;) {
      if (budgetUsd != null && cumulativeCost >= budgetUsd) {
        process.stdout.write(
          `${greenOut(SYM_OUT.bullet)} ${boldOut("watch budget reached")}${dimOut(` $${cumulativeCost.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} — stopping`)}\n`
        );
        if (notify) notifyComplete(0, false);
        return;
      }
      // Poll every scope this cycle. Run one loop for the FIRST scope with
      // work, then break back to the sleep+repoll — one loop at a time, no
      // parallel mutation of the workspace. A failed poll for one scope is
      // logged and skipped so it never blocks polling the others.
      let ran = false;
      let allIdle = true;
      for (const s of scopeList) {
        const sRepo = ghRepoOf(s);
        const sProject = linearProjectOf(s);
        const sLabel = labelOf(s);
        // Pin the Linear project before polling so the poller (which reads it
        // from the inherited env, not a poll arg) is confined to this scope;
        // it also stays pinned for the loop run below. GitHub uses the sRepo
        // poll arg instead and pins OTTO_GITHUB_REPO only on the run.
        if (sProject) process.env.OTTO_LINEAR_PROJECT = sProject;
        const poll = await pollIssues(watchLabel, workspaceDir, sRepo);
        if (!poll.ok) {
          // Broken poll — say *why*, distinctly from an idle queue, and keep
          // polling (auth may get fixed / a transient failure may clear).
          allIdle = false;
          wasIdle = false;
          const suffix = poll.detail ? ` — ${poll.detail}` : "";
          const why = poll.auth
            ? `${sLabel}${provider.name} not authenticated — run '${provider.authCmd}' (label ${watchLabel})${suffix}`
            : `${sLabel}${provider.name} issue poll failed (label ${watchLabel})${suffix}`;
          process.stderr.write(`${dim(why)}\n`);
          continue;
        }
        if (poll.count > 0) {
          allIdle = false;
          wasIdle = false;
          process.stderr.write(
            `${dim(`${sLabel}${poll.count} open issue(s) labelled ${watchLabel} — running loop`)}\n`
          );
          // Confine this loop's `gh` commands (render-time tags + the spawned
          // agent) to the selected scope by pinning OTTO_GITHUB_REPO before the
          // run; single-target left it set in run-bin, this covers multi-target.
          if (sRepo) process.env.OTTO_GITHUB_REPO = sRepo;
          const remaining =
            budgetUsd != null ? budgetUsd - cumulativeCost : undefined;
          const outcome = await runLoop({
            stages,
            inputs: "",
            iterations,
            workspaceDir,
            packageDir,
            budgetUsd: remaining,
            cooldownMs,
            tokenMode,
            maxRetries,
            reviewLenses,
            noKeepAlive: true,
            signal: daemonAbort.signal,
            bin,
            cliVersion: opts.cliVersion,
            agentId: opts.agentId,
            agentDisplayName: opts.agentDisplayName,
          });
          cumulativeCost += outcome.costUsd;
          process.stderr.write(
            `${dim(`${sLabel}watch run done — cumulative $${cumulativeCost.toFixed(2)}`)}\n`
          );
          ran = true;
          break;
        }
      }
      if (!ran && allIdle && !wasIdle) {
        // First empty poll after activity — announce idle once, then stay quiet
        // until a queue becomes non-empty (or a poll fails) and idles again.
        wasIdle = true;
        process.stderr.write(
          `${dim(`no open issues labelled ${watchLabel} — idle, next poll in ${watchIntervalSec}s`)}\n`
        );
      }
      await sleep(watchIntervalSec * 1000, daemonAbort.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
  }
}
