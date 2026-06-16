import { execFileSync } from "node:child_process";
import { acquire, type Releaser } from "./keepalive.js";
import { runLoop } from "./loop.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep } from "./pacing.js";
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

/**
 * Outcome of one issue poll. Distinguishes a real idle queue (`ok` with
 * `count: 0`) from a broken poll (`!ok`) so the daemon can say *why* it is not
 * working — an empty queue and a failed/unauthenticated `gh` are very different
 * states for a maintainer reading the log.
 */
export type PollResult =
  | { ok: true; count: number }
  | { ok: false; auth: boolean; detail: string };

/** Poll open issues carrying `label`, via gh. Never throws. */
export function pollOpenIssues(label: string, cwd: string): PollResult {
  try {
    // execFileSync (no shell) so `label` is passed as a literal argv entry — a
    // value like `$(rm -rf ~)` can never be shell-evaluated. See SECURITY.md.
    // stderr is piped (not ignored) so a failure's message can be classified.
    const out = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
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
    const auth = /auth login|not logged|unauthenticated|credential|\b401\b/i.test(
      stderr
    );
    const detail = stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
    return { ok: false, auth, detail };
  }
}

export type RunWatchOptions = {
  stages: [Stage, ...Stage[]];
  iterations: number;
  workspaceDir: string;
  packageDir: string;
  watchIntervalSec: number;
  watchLabel: string;
  budgetUsd?: number;
  cooldownMs?: number;
  maxRetries?: number;
  reviewLenses?: string[];
  notify?: boolean;
  bin?: string;
  cliVersion?: string;
  /** Injectable for tests; defaults to pollOpenIssues. */
  pollIssues?: (label: string, cwd: string) => PollResult;
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
    maxRetries,
    reviewLenses,
    notify = false,
    bin = "otto-ghafk",
    pollIssues = pollOpenIssues,
  } = opts;

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
    `${USE_COLOR ? dim("watching") + " " + bold(`label:${watchLabel} every ${watchIntervalSec}s`) : `watching label:${watchLabel} every ${watchIntervalSec}s`}\n`
  );

  let cumulativeCost = 0;
  try {
    for (;;) {
      if (budgetUsd != null && cumulativeCost >= budgetUsd) {
        process.stdout.write(
          `${greenOut(SYM_OUT.bullet)} ${boldOut("watch budget reached")}${dimOut(` $${cumulativeCost.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} — stopping`)}\n`
        );
        if (notify) notifyComplete(0, false);
        return;
      }
      const poll = pollIssues(watchLabel, workspaceDir);
      if (!poll.ok) {
        // Broken poll — say *why*, distinctly from an idle queue, and keep
        // polling (auth may get fixed / a transient failure may clear).
        const why = poll.auth
          ? `gh not authenticated — run 'gh auth login' (label ${watchLabel})`
          : `gh issue poll failed (label ${watchLabel})${poll.detail ? ` — ${poll.detail}` : ""}`;
        process.stderr.write(`${dim(why)}\n`);
      } else if (poll.count > 0) {
        process.stderr.write(
          `${dim(`${poll.count} open issue(s) labelled ${watchLabel} — running loop`)}\n`
        );
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
          maxRetries,
          reviewLenses,
          noKeepAlive: true,
          signal: daemonAbort.signal,
          bin,
          cliVersion: opts.cliVersion,
        });
        cumulativeCost += outcome.costUsd;
        process.stderr.write(
          `${dim(`watch run done — cumulative $${cumulativeCost.toFixed(2)}`)}\n`
        );
      } else {
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
