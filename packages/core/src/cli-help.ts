import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAgentId,
  type AgentRuntimeId,
  type AgentSelectionSource,
} from "./agent-runtime.js";
import { runPreflight } from "./preflight.js";
import { resolveModelSelection } from "./runner.js";
import type { TierLadder } from "./model-tier.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import { parseTokenMode, type TokenMode } from "./tokens.js";

export type CliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  /** `--context-report` toggle (default false; issue #62 P7). Prints the latest
   *  run's per-stage context composition + token slope, then exits. */
  contextReport: boolean;
  /** `--plan-report` toggle (default false; issue #63 P8). Scores the authored
   *  plans under `.otto/tasks/` with the plan-quality rubric, then exits. */
  planReport: boolean;
  noKeepAlive: boolean;
  maxRetries?: number;
  detach: boolean;
  log?: string;
  notify: boolean;
  budget?: number;
  cooldownMs?: number;
  tokenMode?: TokenMode;
  /**
   * Validated `--agent` value (the active agent CLI runtime). Undefined when the
   * flag is absent; run-bin then falls back to OTTO_AGENT / .otto/config.json /
   * the `claude` default. Validated here so an invalid flag fails fast.
   */
  agent?: AgentRuntimeId;
  /**
   * Validated `--fallback-agent` value: the runtime Otto switches to when the
   * active runtime hits a usage/rate limit. Undefined when the flag is absent
   * (run-bin then falls back to OTTO_FALLBACK_AGENT / config / no fallback).
   * Default behavior is unchanged — fallback is opt-in (issue #24 P4).
   */
  fallbackAgent?: AgentRuntimeId;
  /** `--auto-switch-on-limit` toggle (default false; opt-in, issue #24 P4). */
  autoSwitchOnLimit: boolean;
  reviewPanel: boolean;
  /** `--verbose` toggle (default false; issue #65 P10). Restores the full in-run
   *  firehose instead of the quiet ConsoleUi. */
  verbose: boolean;
  /** `--adaptive-router` toggle (default false; opt-in, issue #41 P2). */
  adaptiveRouter: boolean;
  /** `--explain-routing` toggle (default false; issue #45 P6). Prints the
   *  adaptive router's per-iteration reasoning; no effect without the router. */
  explainRouting: boolean;
  /** `--model-routing` toggle (default false; opt-in, issue #66 P11). Routes each
   *  stage to a model tier by difficulty + change risk + failure escalation. */
  modelRouting: boolean;
  watch: boolean;
  watchIntervalSec?: number;
  /**
   * Normalized `--issue` value. A number for GitHub refs (the default parser);
   * a canonical string for Linear refs (`ENG-123` / UUID, via an injected
   * `parseIssue`). In both cases it is shell-safe for `OTTO_ISSUE`.
   */
  issue?: number | string;
  /** `--include-sub-issues` toggle (default false; opt-in, issue #28).
   *  Only meaningful with `--issue` on otto-ghafk; run-bin enforces that. */
  includeSubIssues: boolean;
  maxWaitMs?: number;
  fresh: boolean;
  verify: boolean;
  /** `--plan` one-shot (issue #63 P8): author a spec + plan for human review,
   *  make no source edits, then exit (otto-afk). */
  plan: boolean;
  applyReview?: string;
  branch?: "current" | "branch" | "worktree";
  branchPrefix?: string;
  /**
   * Raw `--branch-convention` value (e.g. `feat`). Validated + slash-normalized
   * into a `<convention>/` namespace by resolveBranch; the canonical, git-ref-safe
   * replacement for the raw `branchPrefix`. Kept raw here so the same validation
   * path also covers the OTTO_BRANCH_CONVENTION env fallback.
   */
  branchConvention?: string;
  /**
   * Raw `--repo owner/name` value (otto-ghafk watch scope). Validated into a
   * WorkScope by run-bin via parseGithubRepo — kept raw here so the single
   * validation path also covers the `OTTO_GITHUB_REPO` env fallback. Equals
   * `repos[0]` — kept for the single-target callers that read one repo.
   */
  repo?: string;
  /**
   * All `--repo` values in order (repeatable, multi-target watch). Empty when no
   * `--repo` is given. run-bin merges this with `OTTO_GITHUB_REPOS` into the
   * scope list; a single entry behaves exactly like the legacy single-target.
   */
  repos: string[];
  /**
   * Raw `--project "Name"` value (otto-linear-afk watch scope). Free text that
   * only ever reaches Linear's GraphQL filter — never a host shell — so unlike
   * --repo it needs no charset validation. Resolved into a linear WorkScope by
   * run-bin; kept raw here so the same path also covers the OTTO_LINEAR_PROJECT
   * env fallback. Equals `projects[0]` — kept for single-target callers.
   */
  project?: string;
  /**
   * All `--project` values in order (repeatable, multi-target Linear watch).
   * Empty when no `--project` is given. run-bin merges this with
   * `OTTO_LINEAR_PROJECTS` into the scope list; a single entry behaves exactly
   * like the legacy single-target. Mirrors `repos` for GitHub.
   */
  projects: string[];
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
  let contextReport = false;
  let planReport = false;
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
  let tokenMode: TokenMode | undefined;
  let expectingTokenMode = false;
  let agent: AgentRuntimeId | undefined;
  let expectingAgent = false;
  let fallbackAgent: AgentRuntimeId | undefined;
  let expectingFallbackAgent = false;
  let autoSwitchOnLimit = false;
  let reviewPanel = false;
  let verbose = false;
  let adaptiveRouter = false;
  let explainRouting = false;
  let modelRouting = false;
  let watch = false;
  let watchIntervalSec: number | undefined;
  let expectingWatchInterval = false;
  let issue: number | string | undefined;
  let expectingIssue = false;
  let includeSubIssues = false;
  let maxWaitMs: number | undefined;
  let expectingMaxWait = false;
  let fresh = false;
  let verify = false;
  let plan = false;
  let applyReview: string | undefined;
  let expectingApplyReview = false;
  let branch: "current" | "branch" | "worktree" | undefined;
  let expectingBranch = false;
  let branchPrefix: string | undefined;
  let expectingBranchPrefix = false;
  let branchConvention: string | undefined;
  let expectingBranchConvention = false;
  const repos: string[] = [];
  let expectingRepo = false;
  const projects: string[] = [];
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
    if (expectingTokenMode) {
      tokenMode = parseTokenMode(a, "--token-mode");
      expectingTokenMode = false;
      continue;
    }
    if (expectingAgent) {
      agent = parseAgentId(a, "--agent");
      expectingAgent = false;
      continue;
    }
    if (expectingFallbackAgent) {
      fallbackAgent = parseAgentId(a, "--fallback-agent");
      expectingFallbackAgent = false;
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
    if (expectingBranchConvention) {
      branchConvention = a;
      expectingBranchConvention = false;
      continue;
    }
    if (expectingRepo) {
      repos.push(a);
      expectingRepo = false;
      continue;
    }
    if (expectingProject) {
      projects.push(a);
      expectingProject = false;
      continue;
    }
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-V" || a === "--version") version = true;
    else if (a === "--print-config") printConfig = true;
    else if (a === "--context-report") contextReport = true;
    else if (a === "--plan-report") planReport = true;
    else if (a === "--no-keep-alive") noKeepAlive = true;
    else if (a === "--max-retries") expectingMaxRetries = true;
    else if (a === "--detach") detach = true;
    else if (a === "--log") expectingLog = true;
    else if (a === "--notify") notify = true;
    else if (a === "--budget") expectingBudget = true;
    else if (a === "--cooldown") expectingCooldown = true;
    else if (a === "--token-mode") expectingTokenMode = true;
    else if (a === "--agent") expectingAgent = true;
    else if (a === "--fallback-agent") expectingFallbackAgent = true;
    else if (a === "--auto-switch-on-limit") autoSwitchOnLimit = true;
    else if (a === "--review-panel") reviewPanel = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--adaptive-router") adaptiveRouter = true;
    else if (a === "--explain-routing") explainRouting = true;
    else if (a === "--model-routing") modelRouting = true;
    else if (a === "--watch") watch = true;
    else if (a === "--watch-interval") expectingWatchInterval = true;
    else if (a === "--issue") expectingIssue = true;
    else if (a === "--include-sub-issues") includeSubIssues = true;
    else if (a === "--max-wait") expectingMaxWait = true;
    else if (a === "--fresh") fresh = true;
    else if (a === "--verify") verify = true;
    else if (a === "--plan") plan = true;
    else if (a === "--apply-review") expectingApplyReview = true;
    else if (a === "--branch") expectingBranch = true;
    else if (a === "--branch-prefix") expectingBranchPrefix = true;
    else if (a === "--branch-convention") expectingBranchConvention = true;
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
  if (expectingTokenMode) {
    throw new Error("--token-mode requires a value");
  }
  if (expectingAgent) {
    throw new Error("--agent requires a value");
  }
  if (expectingFallbackAgent) {
    throw new Error("--fallback-agent requires a value");
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
  if (expectingBranchConvention) {
    throw new Error("--branch-convention requires a value");
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
    contextReport,
    planReport,
    noKeepAlive,
    maxRetries,
    detach,
    log,
    notify,
    budget,
    cooldownMs,
    tokenMode,
    agent,
    fallbackAgent,
    autoSwitchOnLimit,
    reviewPanel,
    verbose,
    adaptiveRouter,
    explainRouting,
    modelRouting,
    watch,
    watchIntervalSec,
    issue,
    includeSubIssues,
    maxWaitMs,
    fresh,
    verify,
    plan,
    applyReview,
    branch,
    branchPrefix,
    branchConvention,
    repo: repos[0],
    repos,
    project: projects[0],
    projects,
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
  --context-report    print the latest run's per-stage context composition + token slope (from .otto/runs/), then exit
  --plan-report       score the authored plans (.otto/tasks/*/spec.md+plan.md) with the plan-quality rubric, then exit
  --no-keep-alive     skip OS wake-lock acquisition (default: acquire system-sleep inhibitor for loop lifetime)
  --max-retries <N>   per-stage retry budget on transient failure (default: 3; 0 disables retries)
  --detach            fork the loop into a background process, print pid + log path, and exit (parent returns 0)
  --log <path>        override the detached log path (default: <workspace>/.otto-tmp/logs/detached-<parent-pid>.log; requires --detach)
  --notify            emit OS notification + terminal bell on loop completion or unrecoverable failure (default: off)
  --budget <usd>      stop the loop when cumulative stage cost reaches this USD ceiling (default: off)
  --cooldown <ms>     wait this many milliseconds between iterations; adaptive backoff doubles on throttle (default: 0)
  --token-mode <mode> token accounting mode: off | measure | reduce (default: off)
  --agent <runtime>   agent CLI runtime: claude | codex (or OTTO_AGENT / .otto/config.json "agent"; default: claude)
  --fallback-agent <runtime>  runtime to switch to on a usage/rate limit: claude | codex (or OTTO_FALLBACK_AGENT / config "fallbackAgent"; default: none)
  --auto-switch-on-limit  switch to the fallback runtime when the active one hits a limit (or OTTO_AUTO_SWITCH_ON_LIMIT=1 / config "autoSwitchOnLimit"; default: off)
  --verbose           print the full in-run event firehose (default: off — quiet mode shows one terse line per meaningful action)
  --review-panel      replace the single reviewer stage with correctness/security/tests lens reviewers + one synth commit (default: off)
  --adaptive-router   route review depth by per-iteration change risk: single reviewer (low) / lens subset (medium) / full panel (high) (or OTTO_ADAPTIVE_ROUTER=1; default: off)
  --explain-routing   print the adaptive router's per-iteration reasoning (change class, risk, chosen depth/lenses); requires --adaptive-router (or OTTO_EXPLAIN_ROUTING=1; default: off)
  --model-routing     route each stage to a model tier by difficulty + change risk, escalating on repeated failure; a pinned --model/OTTO_MODEL overrides it (or OTTO_MODEL_ROUTING=1; default: off)
  --branch <mode>     where Otto commits: current (default) | branch (new branch) | worktree (isolated checkout)
  --branch-prefix <p> branch name prefix for branch/worktree modes (default: otto/)
  --branch-convention <c>  validated branch namespace <c>/<task-key> (e.g. feat, feature, fix); normalizes a trailing slash; overrides --branch-prefix (or OTTO_BRANCH_CONVENTION; default: otto)
  --watch             poll for labelled issues and run the loop whenever work is found (otto-ghafk + otto-linear-afk; default: off)
  --watch-interval <sec>  seconds between polls in watch mode (default: 300)
  --repo <owner/name> scope otto-ghafk to a GitHub repo: poll + list + view only that repo's issues (or OTTO_GITHUB_REPO; default: the workspace's repo); repeatable for multi-target watch (or OTTO_GITHUB_REPOS=owner/a,owner/b)
  --project <name>    scope otto-linear-afk to a Linear project (narrows team/label further; or OTTO_LINEAR_PROJECT; default: no project filter); repeatable for multi-target watch (or OTTO_LINEAR_PROJECTS="Roadmap Q3,Bugs")
  --issue <ref>       target a single issue (otto-ghafk: number, #N, owner/repo#N, or URL; otto-linear-afk: ENG-123, UUID, or Linear URL); loop exits when it is done (default: off)
  --include-sub-issues  with --issue (otto-ghafk): also implement the issue's open sub-issues — native GitHub sub-issues, or a markdown task-list (- [ ] #N) fallback — depth-first, parent skipped (or OTTO_INCLUDE_SUB_ISSUES=1; default: off)
  --max-wait <dur>    cap the wait when rate-limited before halting (e.g. 90m, 6h; default 6h)
  --fresh             ignore any saved resume state and start from iteration 1
  --verify            read-only: reconcile the plan against git, run the suites, write a report; make no commits (otto-afk)
  --plan              one-shot: author a spec + plan under .otto/tasks/ for human review, make no source edits, then exit (otto-afk)
  --apply-review <doc>  fix the actionable findings of a code-review document; track follow-ups (otto-afk)

Environment variables:
  OTTO_WORKSPACE   host dir Claude runs against (default: cwd)
  OTTO_RUNNER      "sandbox" (default) runs claude in the native OS sandbox with
                    writes confined to the workspace; "host" runs claude unsandboxed
                    (bare while-loop — only safe in a throwaway tree).
  OTTO_SANDBOX_NET comma-separated domain allowlist for sandbox network egress.
                    Unset = unrestricted (filesystem is the blast-radius control).
  OTTO_MODEL       pin the model for the active runtime ("--model <value>"
                    pass-through). Unset = the runtime CLI's default; the CLI
                    validates the value.
  OTTO_CLAUDE_MODEL / OTTO_CODEX_MODEL  provider-specific model override applied
                    only when that runtime is active; wins over OTTO_MODEL.
  OTTO_RESULT_GRACE_MS  post-result grace timer ms (default 30000; 0 disables).
  OTTO_TOKEN_MODE   default token accounting mode: off | measure | reduce.
  OTTO_AGENT        default agent CLI runtime: claude | codex; same as --agent (default: claude).
  OTTO_FALLBACK_AGENT  runtime to switch to on a usage/rate limit: claude | codex; same as --fallback-agent (default: none).
  OTTO_AUTO_SWITCH_ON_LIMIT  switch to the fallback runtime on a limit when truthy (1/true/yes/on); same as --auto-switch-on-limit (default: off).
  OTTO_REVIEW_LENSES   comma-separated lens list for --review-panel (default: correctness,security,tests).
  OTTO_ADAPTIVE_ROUTER  route review depth by change risk when truthy (1/true/yes/on); same as --adaptive-router (default: off).
  OTTO_EXPLAIN_ROUTING  print the adaptive router's per-iteration reasoning when truthy (1/true/yes/on); same as --explain-routing (default: off).
  OTTO_WATCH_LABEL     issue label to poll for in watch mode (default: "otto").
  OTTO_INCLUDE_SUB_ISSUES  set to 1/true/yes to enable --include-sub-issues without the flag.
  OTTO_GITHUB_REPO     scope otto-ghafk to a single GitHub repo ("owner/name"); same as --repo.
  OTTO_GITHUB_REPOS    scope otto-ghafk watch to several GitHub repos (comma-separated "owner/a,owner/b"); same as repeating --repo.
  OTTO_LINEAR_PROJECT  scope otto-linear-afk to a single Linear project (name); same as --project.
  OTTO_LINEAR_PROJECTS scope otto-linear-afk watch to several Linear projects (comma-separated "Roadmap Q3,Bugs"); same as repeating --project.
  OTTO_MAX_WAIT        default rate-limit wait cap (seconds or 90m/6h; default 6h).
  OTTO_BRANCH          default branch strategy (current|branch|worktree) when --branch is absent.
  OTTO_BRANCH_PREFIX   default branch-name prefix (default: "otto/").
  OTTO_BRANCH_CONVENTION  default validated branch namespace; same as --branch-convention (default: "otto").
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
  tokenMode?: TokenMode | string;
  tokenModeError?: string;
  /** Resolved active runtime id (e.g. "claude"); omitted → claude default. */
  agentId?: AgentRuntimeId;
  /** Display name for the active runtime (e.g. "Claude Code"). */
  agentDisplayName?: string;
  /** Where the runtime selection came from (default | flag | env | config). */
  agentSource?: AgentSelectionSource;
  /** Set when OTTO_AGENT / config "agent" was invalid; reported, not thrown. */
  agentError?: string;
  /** Resolved fallback runtime id (issue #24 P4); omitted → no fallback. */
  fallbackAgentId?: AgentRuntimeId;
  /** Display name for the fallback runtime (e.g. "Codex CLI"). */
  fallbackAgentDisplayName?: string;
  /** Where the fallback selection came from (flag | env | config). */
  fallbackSource?: AgentSelectionSource;
  /** auto-switch-on-limit enabled (default false). */
  autoSwitchOnLimit?: boolean;
  /** Set when OTTO_FALLBACK_AGENT / config was invalid; reported, not thrown. */
  fallbackError?: string;
  /** Resolved review lenses (empty array = single reviewer). */
  reviewLenses?: string[];
  /** Verbose mode enabled (issue #65 P10): restore full in-run firehose. */
  verbose?: boolean;
  /** Adaptive router enabled (issue #41 P2). */
  adaptiveRouter?: boolean;
  /** Explain-routing enabled (issue #45 P6); no effect without the router. */
  explainRouting?: boolean;
  /** Model routing enabled (issue #66 P11). */
  modelRouting?: boolean;
  /** Resolved tier → model ladder, shown when model routing is on (issue #66 P11). */
  tierLadder?: TierLadder;
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
  includeSubIssues?: boolean;
  maxWaitMs?: number;
  mode?: string;
  branchStrategy?: "current" | "branch" | "worktree";
  branchPrefix?: string;
  branchConvention?: string;
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
    tokenMode = "off",
    tokenModeError,
    agentId = "claude",
    agentDisplayName = "Claude Code",
    agentSource = "default",
    agentError,
    fallbackAgentId,
    fallbackAgentDisplayName,
    fallbackSource,
    autoSwitchOnLimit = false,
    fallbackError,
    verbose = false,
    reviewLenses = [],
    adaptiveRouter = false,
    explainRouting = false,
    modelRouting = false,
    tierLadder,
    watch = false,
    watchIntervalSec,
    watchLabel = process.env.OTTO_WATCH_LABEL?.trim() || "otto",
    watchScope,
    issue,
    includeSubIssues = false,
    maxWaitMs,
    mode,
    branchStrategy,
    branchPrefix,
    branchConvention,
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
  const modelSel = resolveModelSelection(agentId);
  const modelStatus = modelSel
    ? `${modelSel.spec} (${modelSel.source})`
    : `${agentId} CLI default (OTTO_${agentId.toUpperCase()}_MODEL / OTTO_MODEL unset)`;

  const runtimeStatus = agentError
    ? `invalid (${agentError})`
    : `${agentId} (${agentDisplayName})`;
  const runtimeSourceStatus = agentError ? "—" : agentSource;
  // Fallback-on-limit (issue #24 P4): off unless a fallback agent is configured;
  // auto-switch is shown alongside (and flagged when on with no agent to use).
  const fallbackStatus = fallbackError
    ? `invalid (${fallbackError})`
    : fallbackAgentId
      ? `${fallbackAgentId} (${fallbackAgentDisplayName}, ${fallbackSource}) · auto-switch ${autoSwitchOnLimit ? "on" : "off"}`
      : autoSwitchOnLimit
        ? "auto-switch on · no fallback agent set"
        : "off";
  const budgetStatus = budget != null ? `$${budget.toFixed(2)}` : "off";
  const cooldownStatus = cooldownMs ? `${cooldownMs}ms` : "off";
  const tokenModeStatus = tokenModeError
    ? `invalid (${tokenMode}; ${tokenModeError})`
    : tokenMode;
  const reviewStatus = reviewLenses.length
    ? `panel: ${reviewLenses.join(", ")}`
    : "single reviewer";
  const routingStatus = adaptiveRouter
    ? `adaptive${explainRouting ? " · explain on" : ""}`
    : explainRouting
      ? "off (--explain-routing needs --adaptive-router)"
      : "off";
  const modelRoutingStatus = modelRouting
    ? tierLadder
      ? `on (cheap=${tierLadder.cheap ?? "default"}, mid=${tierLadder.mid ?? "default"}, strong=${tierLadder.strong ?? "default"})`
      : "on"
    : "off";
  const watchStatus = watch
    ? `on (every ${watchIntervalSec ?? 300}s, label "${watchLabel}")`
    : "off";
  const scopeStatus = watchScope ?? "default (workspace repo / team)";
  // GitHub refs are numbers (rendered `#42`); Linear refs are already-canonical
  // strings (`ENG-123` / UUID) and stand alone.
  const issueStatus =
    issue == null ? "off" : typeof issue === "number" ? `#${issue}` : issue;
  const branchNamespace =
    branchConvention != null
      ? `convention "${branchConvention}"`
      : `prefix "${branchPrefix ?? "otto/"}"`;
  const branchStatus = `${branchStrategy ?? "current"} (${branchNamespace})`;

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  mode                  ${mode ?? "afk"}
  OTTO_WORKSPACE       ${workspaceDir}${process.env.OTTO_WORKSPACE ? "" : "  (default: cwd)"}
  packageDir            ${packageDir}
  runtime               ${runtimeStatus}
  runtime source        ${runtimeSourceStatus}
  fallback              ${fallbackStatus}
  OTTO_RUNNER          ${runner}${process.env.OTTO_RUNNER ? "" : "  (default)"}
  sandbox network       ${netStatus}
  model                 ${modelStatus}
  keep-alive            ${keepAliveStatus}
  max-retries           ${maxRetries}
  detach                ${detachStatus}
  notify                ${notifyStatus}
  budget                ${budgetStatus}
  cooldown              ${cooldownStatus}
  token mode            ${tokenModeStatus}
  max-wait              ${maxWaitMs != null ? `${Math.round(maxWaitMs / 60000)}m` : "6h (default)"}
  verbose               ${verbose}
  review                ${reviewStatus}
  routing               ${routingStatus}
  model routing         ${modelRoutingStatus}
  branch                ${branchStatus}
  watch                 ${watchStatus}
  scope                 ${scopeStatus}
  issue                 ${issueStatus}
  sub-issues            ${includeSubIssues ? "on" : "off"}
`);

  // Preflight: report whether the run's prerequisites are satisfied so a user
  // can debug setup before any paid `claude` invocation.
  const preflight = runPreflight({ bin, workspaceDir, agentId });
  const preflightLines = preflight
    .map((r) => `  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(20)}${r.detail}`)
    .join("\n");
  process.stdout.write(`
[${bin}] preflight
${preflightLines}
`);
}
