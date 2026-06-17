import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflight } from "./preflight.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";

export type CliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  noKeepAlive: boolean;
  maxRetries?: number;
  detach: boolean;
  log?: string;
  notify: boolean;
  budget?: number;
  cooldownMs?: number;
  reviewPanel: boolean;
  watch: boolean;
  watchIntervalSec?: number;
  /**
   * Normalized `--issue` value. A number for GitHub refs (the default parser);
   * a canonical string for Linear refs (`ENG-123` / UUID, via an injected
   * `parseIssue`). In both cases it is shell-safe for `OTTO_ISSUE`.
   */
  issue?: number | string;
  maxWaitMs?: number;
  fresh: boolean;
  verify: boolean;
  applyReview?: string;
  branch?: "current" | "branch" | "worktree";
  branchPrefix?: string;
  /**
   * Raw `--repo owner/name` value (otto-ghafk watch scope). Validated into a
   * WorkScope by run-bin via parseGithubRepo — kept raw here so the single
   * validation path also covers the `OTTO_GITHUB_REPO` env fallback.
   */
  repo?: string;
  /**
   * Raw `--project "Name"` value (otto-linear-afk watch scope). Free text that
   * only ever reaches Linear's GraphQL filter — never a host shell — so unlike
   * --repo it needs no charset validation. Resolved into a linear WorkScope by
   * run-bin; kept raw here so the same path also covers the OTTO_LINEAR_PROJECT
   * env fallback.
   */
  project?: string;
  rest: string[];
};

/** Parse a duration: bare integer = seconds; suffix s/m/h supported. Throws on invalid. */
export function parseDurationMs(raw: string): number {
  const m = raw.trim().match(/^(\d+)(s|m|h)?$/);
  if (!m) {
    throw new Error(
      `--max-wait must be seconds or a duration like 90m / 6h, got: ${JSON.stringify(raw)}`
    );
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "s";
  const factor = unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000;
  return n * factor;
}

/**
 * Normalize a user-supplied issue reference to a positive integer.
 * Accepts: `42`, `#42`, `owner/repo#42`, and GitHub issue URLs
 * (`https://github.com/owner/repo/issues/42[#anchor]`). A repo component is
 * ignored — only the number is used (gh resolves the repo from the workspace).
 * Throws on anything that is not a positive integer.
 *
 * SECURITY: the returned integer is the ONLY part of the ref that may reach a
 * shell (via the OTTO_ISSUE env var read by a static template command). Never
 * pass the raw ref to a shell. See render.ts security invariant.
 */
export function parseIssueRef(raw: string): number {
  const s = raw.trim();
  let token = s;
  const urlMatch = s.match(/\/issues\/(\d+)(?:[#?].*)?$/);
  if (urlMatch) {
    token = urlMatch[1];
  } else if (s.includes("#")) {
    token = s.slice(s.lastIndexOf("#") + 1);
  }
  if (!/^[1-9]\d*$/.test(token)) {
    throw new Error(
      `--issue must be a positive issue number, #N, owner/repo#N, or a GitHub issue URL, got: ${JSON.stringify(raw)}`
    );
  }
  const n = Number.parseInt(token, 10);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`--issue number is too large, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Options for {@link parseFlags}. */
export type ParseFlagsOptions = {
  /**
   * How to validate/normalize the `--issue` value. Defaults to the GitHub
   * number ref ({@link parseIssueRef}); otto-linear-afk injects a Linear parser.
   */
  parseIssue?: (raw: string) => number | string;
};

export function parseFlags(
  argv: string[],
  opts: ParseFlagsOptions = {}
): CliFlags {
  const parseIssue = opts.parseIssue ?? parseIssueRef;
  let help = false;
  let version = false;
  let printConfig = false;
  let noKeepAlive = false;
  let maxRetries: number | undefined;
  let expectingMaxRetries = false;
  let detach = false;
  let log: string | undefined;
  let expectingLog = false;
  let notify = false;
  let budget: number | undefined;
  let expectingBudget = false;
  let cooldownMs: number | undefined;
  let expectingCooldown = false;
  let reviewPanel = false;
  let watch = false;
  let watchIntervalSec: number | undefined;
  let expectingWatchInterval = false;
  let issue: number | string | undefined;
  let expectingIssue = false;
  let maxWaitMs: number | undefined;
  let expectingMaxWait = false;
  let fresh = false;
  let verify = false;
  let applyReview: string | undefined;
  let expectingApplyReview = false;
  let branch: "current" | "branch" | "worktree" | undefined;
  let expectingBranch = false;
  let branchPrefix: string | undefined;
  let expectingBranchPrefix = false;
  let repo: string | undefined;
  let expectingRepo = false;
  let project: string | undefined;
  let expectingProject = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (expectingMaxRetries) {
      if (!/^\d+$/.test(a)) {
        throw new Error(
          `--max-retries must be a non-negative integer, got: ${JSON.stringify(a)}`
        );
      }
      maxRetries = Number.parseInt(a, 10);
      expectingMaxRetries = false;
      continue;
    }
    if (expectingLog) {
      log = a;
      expectingLog = false;
      continue;
    }
    if (expectingBudget) {
      const n = Number(a);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `--budget must be a positive number, got: ${JSON.stringify(a)}`
        );
      }
      budget = n;
      expectingBudget = false;
      continue;
    }
    if (expectingCooldown) {
      if (!/^\d+$/.test(a)) {
        throw new Error(
          `--cooldown must be a non-negative integer (ms), got: ${JSON.stringify(a)}`
        );
      }
      cooldownMs = Number.parseInt(a, 10);
      expectingCooldown = false;
      continue;
    }
    if (expectingWatchInterval) {
      if (!/^\d+$/.test(a) || Number.parseInt(a, 10) <= 0) {
        throw new Error(
          `--watch-interval must be a positive integer (seconds), got: ${JSON.stringify(a)}`
        );
      }
      watchIntervalSec = Number.parseInt(a, 10);
      expectingWatchInterval = false;
      continue;
    }
    if (expectingIssue) {
      issue = parseIssue(a);
      expectingIssue = false;
      continue;
    }
    if (expectingMaxWait) {
      maxWaitMs = parseDurationMs(a);
      expectingMaxWait = false;
      continue;
    }
    if (expectingApplyReview) {
      applyReview = a;
      expectingApplyReview = false;
      continue;
    }
    if (expectingBranch) {
      if (a !== "current" && a !== "branch" && a !== "worktree") {
        throw new Error(
          `--branch must be one of current|branch|worktree, got: ${JSON.stringify(a)}`
        );
      }
      branch = a;
      expectingBranch = false;
      continue;
    }
    if (expectingBranchPrefix) {
      branchPrefix = a;
      expectingBranchPrefix = false;
      continue;
    }
    if (expectingRepo) {
      repo = a;
      expectingRepo = false;
      continue;
    }
    if (expectingProject) {
      project = a;
      expectingProject = false;
      continue;
    }
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-V" || a === "--version") version = true;
    else if (a === "--print-config") printConfig = true;
    else if (a === "--no-keep-alive") noKeepAlive = true;
    else if (a === "--max-retries") expectingMaxRetries = true;
    else if (a === "--detach") detach = true;
    else if (a === "--log") expectingLog = true;
    else if (a === "--notify") notify = true;
    else if (a === "--budget") expectingBudget = true;
    else if (a === "--cooldown") expectingCooldown = true;
    else if (a === "--review-panel") reviewPanel = true;
    else if (a === "--watch") watch = true;
    else if (a === "--watch-interval") expectingWatchInterval = true;
    else if (a === "--issue") expectingIssue = true;
    else if (a === "--max-wait") expectingMaxWait = true;
    else if (a === "--fresh") fresh = true;
    else if (a === "--verify") verify = true;
    else if (a === "--apply-review") expectingApplyReview = true;
    else if (a === "--branch") expectingBranch = true;
    else if (a === "--branch-prefix") expectingBranchPrefix = true;
    else if (a === "--repo") expectingRepo = true;
    else if (a === "--project") expectingProject = true;
    else rest.push(a);
  }
  if (expectingMaxRetries) {
    throw new Error("--max-retries requires a value");
  }
  if (expectingLog) {
    throw new Error("--log requires a value");
  }
  if (expectingBudget) {
    throw new Error("--budget requires a value");
  }
  if (expectingCooldown) {
    throw new Error("--cooldown requires a value");
  }
  if (expectingWatchInterval) {
    throw new Error("--watch-interval requires a value");
  }
  if (expectingIssue) {
    throw new Error("--issue requires a value");
  }
  if (expectingMaxWait) {
    throw new Error("--max-wait requires a value");
  }
  if (expectingApplyReview) {
    throw new Error("--apply-review requires a value");
  }
  if (expectingBranch) {
    throw new Error("--branch requires a value");
  }
  if (expectingBranchPrefix) {
    throw new Error("--branch-prefix requires a value");
  }
  if (expectingRepo) {
    throw new Error("--repo requires a value");
  }
  if (expectingProject) {
    throw new Error("--project requires a value");
  }
  if (log !== undefined && !detach) {
    throw new Error("--log is only meaningful with --detach");
  }
  return {
    help,
    version,
    printConfig,
    noKeepAlive,
    maxRetries,
    detach,
    log,
    notify,
    budget,
    cooldownMs,
    reviewPanel,
    watch,
    watchIntervalSec,
    issue,
    maxWaitMs,
    fresh,
    verify,
    applyReview,
    branch,
    branchPrefix,
    repo,
    project,
    rest,
  };
}

/**
 * Resolve the @phamvuhoang/otto-core version by reading the package.json that
 * sits two levels up from the compiled cli-help.js (packages/core/dist/ →
 * packages/core/package.json). Returns "?" if unreadable so version reporting
 * never crashes the bin.
 */
export function readCoreVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export function printVersion(bin: string, cliVersion?: string): void {
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";
  process.stdout.write(`${bin} ${cli} (core ${core})\n`);
}

export function printHelp(
  bin: string,
  usage: string,
  description: string
): void {
  process.stdout.write(`${bin} — ${description}

Usage:
  ${bin} ${usage}
  ${bin} --help | -h
  ${bin} --version | -V
  ${bin} --print-config [args...]

Flags:
  -h, --help          show this help and exit
  -V, --version       print bin + core version and exit
  --print-config      print resolved config + a preflight check of run prerequisites, then exit
  --no-keep-alive     skip OS wake-lock acquisition (default: acquire system-sleep inhibitor for loop lifetime)
  --max-retries <N>   per-stage retry budget on transient failure (default: 3; 0 disables retries)
  --detach            fork the loop into a background process, print pid + log path, and exit (parent returns 0)
  --log <path>        override the detached log path (default: <workspace>/.otto-tmp/logs/detached-<parent-pid>.log; requires --detach)
  --notify            emit OS notification + terminal bell on loop completion or unrecoverable failure (default: off)
  --budget <usd>      stop the loop when cumulative stage cost reaches this USD ceiling (default: off)
  --cooldown <ms>     wait this many milliseconds between iterations; adaptive backoff doubles on throttle (default: 0)
  --review-panel      replace the single reviewer stage with correctness/security/tests lens reviewers + one synth commit (default: off)
  --branch <mode>     where Otto commits: current (default) | branch (new branch) | worktree (isolated checkout)
  --branch-prefix <p> branch name prefix for branch/worktree modes (default: otto/)
  --watch             poll for labelled issues and run the loop whenever work is found (otto-ghafk + otto-linear-afk; default: off)
  --watch-interval <sec>  seconds between polls in watch mode (default: 300)
  --repo <owner/name> scope otto-ghafk to a single GitHub repo: poll + list + view only that repo's issues (or OTTO_GITHUB_REPO; default: the workspace's repo)
  --project <name>    scope otto-linear-afk to a single Linear project (narrows team/label further; or OTTO_LINEAR_PROJECT; default: no project filter)
  --issue <ref>       target a single issue (otto-ghafk: number, #N, owner/repo#N, or URL; otto-linear-afk: ENG-123, UUID, or Linear URL); loop exits when it is done (default: off)
  --max-wait <dur>    cap the wait when rate-limited before halting (e.g. 90m, 6h; default 6h)
  --fresh             ignore any saved resume state and start from iteration 1
  --verify            read-only: reconcile the plan against git, run the suites, write a report; make no commits (otto-afk)
  --apply-review <doc>  fix the actionable findings of a code-review document; track follow-ups (otto-afk)

Environment variables:
  OTTO_WORKSPACE   host dir Claude runs against (default: cwd)
  OTTO_RUNNER      "sandbox" (default) runs claude in the native OS sandbox with
                    writes confined to the workspace; "host" runs claude unsandboxed
                    (bare while-loop — only safe in a throwaway tree).
  OTTO_SANDBOX_NET comma-separated domain allowlist for sandbox network egress.
                    Unset = unrestricted (filesystem is the blast-radius control).
  OTTO_MODEL       pin the claude model ("--model <value>" pass-through). Unset =
                    claude CLI default. The claude CLI validates the value.
  OTTO_RESULT_GRACE_MS  post-result grace timer ms (default 30000; 0 disables).
  OTTO_REVIEW_LENSES   comma-separated lens list for --review-panel (default: correctness,security,tests).
  OTTO_WATCH_LABEL     issue label to poll for in watch mode (default: "otto").
  OTTO_GITHUB_REPO     scope otto-ghafk to a single GitHub repo ("owner/name"); same as --repo.
  OTTO_LINEAR_PROJECT  scope otto-linear-afk to a single Linear project (name); same as --project.
  OTTO_MAX_WAIT        default rate-limit wait cap (seconds or 90m/6h; default 6h).
  OTTO_BRANCH          default branch strategy (current|branch|worktree) when --branch is absent.
  OTTO_BRANCH_PREFIX   default branch-name prefix (default: "otto/").
`);
}

export type PrintConfigOptions = {
  cliVersion?: string;
  noKeepAlive?: boolean;
  maxRetries?: number;
  detach?: boolean;
  detachLogPath?: string;
  notify?: boolean;
  budget?: number;
  cooldownMs?: number;
  /** Resolved review lenses (empty array = single reviewer). */
  reviewLenses?: string[];
  watch?: boolean;
  watchIntervalSec?: number;
  /**
   * Label a --watch run would poll, pre-resolved by run-bin's per-mode
   * resolveWatchLabel. Passed in (not re-derived here) so the reported label
   * can't drift from the actual watch run. Defaults to the gh resolution.
   */
  watchLabel?: string;
  /**
   * Resolved work scope (e.g. `github owner/name`), pre-rendered via
   * describeScope. Shown so a user sees the exact repo/team/project a run (and
   * especially a --watch run) will be confined to before it starts.
   */
  watchScope?: string;
  issue?: number | string;
  maxWaitMs?: number;
  mode?: string;
  branchStrategy?: "current" | "branch" | "worktree";
  branchPrefix?: string;
};

export function printConfig(
  bin: string,
  workspaceDir: string,
  packageDir: string,
  opts: PrintConfigOptions = {}
): void {
  const {
    cliVersion,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    detach = false,
    detachLogPath,
    notify = false,
    budget,
    cooldownMs,
    reviewLenses = [],
    watch = false,
    watchIntervalSec,
    watchLabel = process.env.OTTO_WATCH_LABEL?.trim() || "otto",
    watchScope,
    issue,
    maxWaitMs,
    mode,
    branchStrategy,
    branchPrefix,
  } = opts;
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";

  const runner =
    process.env.OTTO_RUNNER?.trim() === "host" ? "host" : "sandbox";
  const rawNet = process.env.OTTO_SANDBOX_NET?.trim();
  const netStatus =
    runner === "host"
      ? "n/a (host runner)"
      : rawNet
        ? `restricted to: ${rawNet}`
        : "unrestricted (filesystem-only sandbox)";

  const keepAliveStatus = noKeepAlive ? "off" : "on (system sleep only)";
  const detachStatus =
    detach && detachLogPath ? `on (log: ${detachLogPath})` : "off";
  const notifyStatus = notify ? "on" : "off";
  const rawModel = process.env.OTTO_MODEL;
  const modelStatus =
    rawModel && rawModel.trim() !== ""
      ? `${rawModel.trim()} (OTTO_MODEL)`
      : "claude CLI default (OTTO_MODEL unset)";

  const budgetStatus = budget != null ? `$${budget.toFixed(2)}` : "off";
  const cooldownStatus = cooldownMs ? `${cooldownMs}ms` : "off";
  const reviewStatus = reviewLenses.length
    ? `panel: ${reviewLenses.join(", ")}`
    : "single reviewer";
  const watchStatus = watch
    ? `on (every ${watchIntervalSec ?? 300}s, label "${watchLabel}")`
    : "off";
  const scopeStatus = watchScope ?? "default (workspace repo / team)";
  // GitHub refs are numbers (rendered `#42`); Linear refs are already-canonical
  // strings (`ENG-123` / UUID) and stand alone.
  const issueStatus =
    issue == null ? "off" : typeof issue === "number" ? `#${issue}` : issue;
  const branchStatus = `${branchStrategy ?? "current"} (prefix "${branchPrefix ?? "otto/"}")`;

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  mode                  ${mode ?? "afk"}
  OTTO_WORKSPACE       ${workspaceDir}${process.env.OTTO_WORKSPACE ? "" : "  (default: cwd)"}
  packageDir            ${packageDir}
  OTTO_RUNNER          ${runner}${process.env.OTTO_RUNNER ? "" : "  (default)"}
  sandbox network       ${netStatus}
  model                 ${modelStatus}
  keep-alive            ${keepAliveStatus}
  max-retries           ${maxRetries}
  detach                ${detachStatus}
  notify                ${notifyStatus}
  budget                ${budgetStatus}
  cooldown              ${cooldownStatus}
  max-wait              ${maxWaitMs != null ? `${Math.round(maxWaitMs / 60000)}m` : "6h (default)"}
  review                ${reviewStatus}
  branch                ${branchStatus}
  watch                 ${watchStatus}
  scope                 ${scopeStatus}
  issue                 ${issueStatus}
`);

  // Preflight: report whether the run's prerequisites are satisfied so a user
  // can debug setup before any paid `claude` invocation.
  const preflight = runPreflight({ bin, workspaceDir });
  const preflightLines = preflight
    .map((r) => `  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(20)}${r.detail}`)
    .join("\n");
  process.stdout.write(`
[${bin}] preflight
${preflightLines}
`);
}
