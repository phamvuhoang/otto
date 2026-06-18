import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readAgentConfig,
  readFallbackConfig,
  resolveAgentRuntime,
  resolveFallback,
  type ResolvedAgentRuntime,
  type ResolvedFallback,
} from "./agent-runtime.js";
import { dirtyTreeWarning, ensureTmpIgnored, resolveBranch } from "./branch.js";
import {
  parseFlags,
  parseDurationMs,
  printConfig,
  printHelp,
  printVersion,
} from "./cli-help.js";
import { detachAndExit } from "./detach.js";
import { runLoop } from "./loop.js";
import { getAgentRuntime } from "./runner.js";
import type { Stage } from "./stages.js";
import { parseGithubRepo, describeScope, type WorkScope } from "./task-key.js";
import type { TokenMode } from "./tokens.js";
import { parseTokenMode } from "./tokens.js";
import type { PollResult, WatchProvider } from "./watch.js";

export type RunBinConfig = {
  /** Bin name for usage/version/config output (e.g. "otto-afk"). */
  bin: string;
  /** Positional-arg usage string (e.g. "<plan-and-prd> <iterations>"). */
  usage: string;
  /** One-line description for --help. */
  desc: string;
  /** Stage chain; first stage is the gate. */
  stages: [Stage, ...Stage[]];
  /**
   * Whether the bin takes a leading input positional before <iterations>.
   * `true`  → argv is `<inputs> <iterations>` (otto-afk; inputs = rest[0]).
   * `false` → argv is `<iterations>`          (otto-ghafk; inputs = "").
   */
  takesInputArg: boolean;
  cliVersion?: string;
  /** Whether this bin supports --watch. otto-ghafk + otto-linear-afk set this. */
  supportsWatch?: boolean;
  /**
   * Provider-specific watch poller. Omitted → runWatch's default gh poller
   * (otto-ghafk); otto-linear-afk passes a Linear poller. May be async.
   */
  watchPoll?: (label: string, cwd: string) => PollResult | Promise<PollResult>;
  /** Provider-specific watch poll/auth messaging; omitted → gh. */
  watchProvider?: WatchProvider;
  /**
   * Resolve the label that gates a --watch run. Omitted → `OTTO_WATCH_LABEL`
   * (otto-ghafk). otto-linear-afk resolves `OTTO_LINEAR_LABEL` so watch polls
   * the same labelled set its implementer selects.
   */
  resolveWatchLabel?: () => string;
  /**
   * Whether this bin accepts `--repo owner/name` / `OTTO_GITHUB_REPO` to confine
   * the run to a single GitHub repo. Only otto-ghafk sets this.
   */
  supportsRepoScope?: boolean;
  /**
   * Whether this bin accepts `--project "Name"` / `OTTO_LINEAR_PROJECT` to
   * narrow the run to a single Linear project. Only otto-linear-afk sets this.
   */
  supportsProjectScope?: boolean;
  /** Alternate gate stage used when --issue is set. Only otto-ghafk sets this. */
  issueStage?: Stage;
  /** Single read-only gate stage used when --verify is set. Only otto-afk sets this. */
  verifyStage?: Stage;
  /** Gate stage used when --apply-review is set. Only otto-afk sets this. */
  applyReviewStage?: Stage;
  /** Run mode identifier threaded into runLoop state (e.g. "afk" / "ghafk"). */
  mode: string;
  /**
   * How to validate/normalize a `--issue` value. Defaults to the GitHub number
   * ref; otto-linear-afk injects a Linear parser. The result must be shell-safe
   * (it becomes OTTO_ISSUE, read by the issue template's static command).
   */
  parseIssue?: (raw: string) => number | string;
};

/**
 * Ensure .otto/state.json is listed in the workspace .gitignore.
 * No-op when the workspace has no .git directory (not a git repo).
 * Kept separate from branch.ts's ensureTmpIgnored: that targets the parent
 * workspaceDir (.otto-tmp/), while state.json lives in the effective workspace
 * (the worktree, in worktree mode) where the loop writes it.
 */
function ensureStateGitignored(workspaceDir: string): void {
  if (!existsSync(join(workspaceDir, ".git"))) return;
  const gitignorePath = join(workspaceDir, ".gitignore");
  const entry = ".otto/state.json";
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const alreadyPresent = existing
    .split("\n")
    .some((line) => line.trim() === entry);
  if (!alreadyPresent) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${prefix}${entry}\n`, "utf8");
  }
}

/**
 * Shared entry for the AFK bins: parse flags, handle --version/--help/--print-config,
 * resolve the workspace / package dirs, validate the positional args,
 * optionally fork into the background (--detach), then drive runLoop.
 */
export async function runBin(argv: string[], cfg: RunBinConfig): Promise<void> {
  const flags = parseFlags(argv, { parseIssue: cfg.parseIssue });

  if (flags.version) {
    printVersion(cfg.bin, cfg.cliVersion);
    return;
  }
  if (flags.help) {
    printHelp(cfg.bin, cfg.usage, cfg.desc);
    return;
  }

  // run-bin.js ships in the same dist/ dir as the bin entrypoints, so ".." is
  // the installed @phamvuhoang/otto-core package dir (which holds templates/).
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.OTTO_WORKSPACE ?? process.cwd());

  const envMaxWait = process.env.OTTO_MAX_WAIT?.trim();
  const maxWaitMs =
    flags.maxWaitMs ?? (envMaxWait ? parseDurationMs(envMaxWait) : undefined);
  let tokenMode: TokenMode = flags.tokenMode ?? "off";
  let tokenModeError: string | undefined;
  if (flags.tokenMode == null) {
    try {
      tokenMode = parseTokenMode(
        process.env.OTTO_TOKEN_MODE,
        "OTTO_TOKEN_MODE"
      );
    } catch (err) {
      tokenModeError = (err as Error).message;
    }
  }

  // Resolve the active agent runtime: --agent flag → OTTO_AGENT → .otto/config.json
  // "agent" → claude default. Mirror the token-mode handling: an invalid env/config
  // value is reported by --print-config (no stack trace) and is fatal on a real run.
  let agent: ResolvedAgentRuntime = {
    id: "claude",
    displayName: "Claude Code",
    source: "default",
  };
  let agentError: string | undefined;
  try {
    agent = resolveAgentRuntime({
      flag: flags.agent,
      env: process.env.OTTO_AGENT,
      config: readAgentConfig(workspaceDir),
    });
  } catch (err) {
    agentError = (err as Error).message;
  }

  // Resolve fallback-on-limit config (--fallback-agent / OTTO_FALLBACK_AGENT /
  // config "fallbackAgent" + --auto-switch-on-limit / OTTO_AUTO_SWITCH_ON_LIMIT /
  // config "autoSwitchOnLimit"). Default OFF — switching providers is opt-in.
  // An invalid value is reported by --print-config and fatal on a real run,
  // mirroring the agent handling.
  let fallback: ResolvedFallback = { autoSwitch: false };
  let fallbackError: string | undefined;
  try {
    const fbCfg = readFallbackConfig(workspaceDir);
    fallback = resolveFallback({
      flagAgent: flags.fallbackAgent,
      envAgent: process.env.OTTO_FALLBACK_AGENT,
      configAgent: fbCfg.agent,
      flagAutoSwitch: flags.autoSwitchOnLimit,
      envAutoSwitch: process.env.OTTO_AUTO_SWITCH_ON_LIMIT,
      configAutoSwitch: fbCfg.autoSwitch,
    });
  } catch (err) {
    fallbackError = (err as Error).message;
  }

  const envBranch = process.env.OTTO_BRANCH?.trim();
  const branchStrategyArg =
    flags.branch ??
    (envBranch === "current" ||
    envBranch === "branch" ||
    envBranch === "worktree"
      ? envBranch
      : undefined);
  const branchPrefixArg =
    flags.branchPrefix ?? (process.env.OTTO_BRANCH_PREFIX?.trim() || undefined);
  const branchConventionArg =
    flags.branchConvention ??
    (process.env.OTTO_BRANCH_CONVENTION?.trim() || undefined);

  const detachLogPath = flags.detach
    ? (flags.log ??
      join(workspaceDir, ".otto-tmp", "logs", `detached-${process.pid}.log`))
    : undefined;

  const DEFAULT_LENSES = ["correctness", "security", "tests"];
  const envLenses = (process.env.OTTO_REVIEW_LENSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reviewLenses =
    envLenses.length > 0
      ? envLenses
      : flags.reviewPanel
        ? DEFAULT_LENSES
        : undefined;

  // Resolve the run mode before the --print-config early-return so it reflects
  // the selected mode. Depends only on flags, not on the guards below.
  const runMode = flags.verify
    ? "verify"
    : flags.applyReview != null
      ? "review"
      : cfg.mode;

  // Single source of truth for the --watch label: the per-mode resolver
  // (otto-linear-afk → OTTO_LINEAR_LABEL) falling back to OTTO_WATCH_LABEL.
  // Both --print-config and the runWatch call below read this, so the reported
  // label can't drift from what a watch run actually polls.
  const watchLabel =
    cfg.resolveWatchLabel?.() || process.env.OTTO_WATCH_LABEL?.trim() || "otto";

  // Resolve the GitHub single-target scope (--repo / OTTO_GITHUB_REPO) up front
  // so --print-config can report it before any run starts. Validated into a
  // WorkScope; the canonical owner/repo is exported as OTTO_GITHUB_REPO so the
  // ghafk templates confine their `gh` commands (list/view) to it, and passed
  // to runWatch so the poller never sees another repo's issues. parseGithubRepo
  // admits only shell-safe chars, keeping OTTO_GITHUB_REPO safe to interpolate.
  let scope: WorkScope | undefined;
  // Multi-target watch: several validated GitHub scopes the daemon rotates
  // through (repeated --repo / OTTO_GITHUB_REPOS). Undefined for the single
  // target path, which keeps using `scope` + the OTTO_GITHUB_REPO env export.
  let scopes: WorkScope[] | undefined;
  let scopeError: string | undefined;
  if (cfg.supportsRepoScope) {
    // Repeated --repo wins; else the comma-list OTTO_GITHUB_REPOS; else the
    // single OTTO_GITHUB_REPO. All go through parseGithubRepo (shell-safe).
    const rawRepos =
      flags.repos.length > 0
        ? flags.repos
        : (process.env.OTTO_GITHUB_REPOS?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []);
    const raw =
      rawRepos.length > 0
        ? rawRepos
        : process.env.OTTO_GITHUB_REPO?.trim()
          ? [process.env.OTTO_GITHUB_REPO.trim()]
          : [];
    try {
      const parsed = raw.map((r) => {
        const { owner, repo } = parseGithubRepo(r);
        return { provider: "github" as const, owner, repo };
      });
      if (parsed.length === 1) {
        scope = parsed[0];
        // Export the canonical owner/repo so the ghafk templates confine their
        // `gh` commands to it (single-target). Multi-target pins it per-cycle
        // inside runWatch instead, so we don't set a single value here.
        process.env.OTTO_GITHUB_REPO = `${parsed[0].owner}/${parsed[0].repo}`;
      } else if (parsed.length > 1) {
        scopes = parsed;
      }
    } catch (err) {
      scopeError = (err as Error).message;
    }
  }
  // Resolve the Linear single-target scope (--project / OTTO_LINEAR_PROJECT)
  // alongside the team filter (OTTO_LINEAR_TEAM). Unlike --repo, a project name
  // is free text that only reaches Linear's GraphQL filter (never a host shell),
  // so it needs no charset validation. The resolved project is re-exported as
  // OTTO_LINEAR_PROJECT so the `otto-linear list/dump` template commands and the
  // watch poller (which read it from the inherited env, like team) honor the
  // flag, not just the env var. Scope is reported even with only a team set.
  if (cfg.supportsProjectScope) {
    const team = process.env.OTTO_LINEAR_TEAM?.trim() || undefined;
    // Repeated --project wins; else the comma-list OTTO_LINEAR_PROJECTS; else the
    // single OTTO_LINEAR_PROJECT. No charset validation — a project name only
    // ever reaches Linear's GraphQL filter, never a host shell.
    const rawProjects =
      flags.projects.length > 0
        ? flags.projects
        : (process.env.OTTO_LINEAR_PROJECTS?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []);
    const projects =
      rawProjects.length > 0
        ? rawProjects
        : process.env.OTTO_LINEAR_PROJECT?.trim()
          ? [process.env.OTTO_LINEAR_PROJECT.trim()]
          : [];
    if (projects.length > 1) {
      // Multi-target: each project pairs with the same team. The daemon pins
      // OTTO_LINEAR_PROJECT per-cycle (in runWatch), so no single value here.
      scopes = projects.map((project) => ({
        provider: "linear" as const,
        team,
        project,
      }));
    } else {
      const project = projects[0];
      // Export the resolved project so the `otto-linear list/dump` template
      // commands and the watch poller (which read it from the inherited env)
      // honor the flag, not just the env var.
      if (project) process.env.OTTO_LINEAR_PROJECT = project;
      if (team || project) scope = { provider: "linear", team, project };
    }
  }
  const watchScope = scopeError
    ? `invalid (${scopeError})`
    : scopes
      ? scopes.map(describeScope).join(", ")
      : scope
        ? describeScope(scope)
        : undefined;

  if (flags.printConfig) {
    printConfig(cfg.bin, workspaceDir, packageDir, {
      cliVersion: cfg.cliVersion,
      mode: runMode,
      noKeepAlive: flags.noKeepAlive,
      maxRetries: flags.maxRetries,
      detach: flags.detach,
      detachLogPath,
      notify: flags.notify,
      budget: flags.budget,
      cooldownMs: flags.cooldownMs,
      tokenMode: tokenModeError
        ? (process.env.OTTO_TOKEN_MODE?.trim() ?? "")
        : tokenMode,
      tokenModeError,
      agentId: agent.id,
      agentDisplayName: agent.displayName,
      agentSource: agent.source,
      agentError,
      fallbackAgentId: fallback.agent?.id,
      fallbackAgentDisplayName: fallback.agent?.displayName,
      fallbackSource: fallback.agent?.source,
      autoSwitchOnLimit: fallback.autoSwitch,
      fallbackError,
      reviewLenses: reviewLenses ?? [],
      watch: flags.watch,
      watchIntervalSec: flags.watchIntervalSec,
      watchLabel,
      watchScope,
      issue: flags.issue,
      maxWaitMs,
      branchStrategy: branchStrategyArg,
      branchPrefix: branchPrefixArg,
      branchConvention: branchConventionArg,
    });
    return;
  }

  if (tokenModeError) {
    console.error(tokenModeError);
    process.exit(1);
  }

  // An invalid OTTO_AGENT / config "agent" is fatal for a real run (it would
  // otherwise silently fall back to claude); --print-config only reported it.
  if (agentError) {
    console.error(agentError);
    process.exit(1);
  }
  // An invalid OTTO_FALLBACK_AGENT / config value is likewise fatal on a real
  // run (it would otherwise silently disable the fallback); --print-config only
  // reported it.
  if (fallbackError) {
    console.error(fallbackError);
    process.exit(1);
  }
  // Only Claude is runnable end-to-end today; selecting another runtime for a
  // real run fails loudly rather than silently running Claude, preserving the
  // "user always knows the active runtime" contract. The Codex adapter lands in
  // a later issue-24 slice. --print-config still reports the selection above.
  if (agent.id !== "claude") {
    console.error(
      `the ${agent.displayName} runtime is not implemented yet; only Claude Code is currently runnable (see issue #24). Selection source: ${agent.source}.`
    );
    process.exit(1);
  }
  // A configured fallback is harmless while auto-switch is off, but an enabled
  // switch must not defer an unavailable-adapter crash until a paid run hits a
  // limit. Validate the fallback adapter before branch setup or stage execution.
  if (fallback.autoSwitch && fallback.agent) {
    try {
      getAgentRuntime(fallback.agent.id);
    } catch (err) {
      console.error(`fallback runtime unavailable: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (flags.issue != null && !cfg.issueStage) {
    console.error(
      "--issue is only supported by otto-ghafk and otto-linear-afk"
    );
    process.exit(1);
  }

  if (flags.repo != null && !cfg.supportsRepoScope) {
    console.error("--repo is only supported by otto-ghafk");
    process.exit(1);
  }
  if (flags.project != null && !cfg.supportsProjectScope) {
    console.error("--project is only supported by otto-linear-afk");
    process.exit(1);
  }
  // A malformed --repo / OTTO_GITHUB_REPO is fatal for a real run (it would
  // silently fall back to the workspace repo); --print-config only reports it.
  if (scopeError) {
    console.error(scopeError);
    process.exit(1);
  }

  const modeCount =
    (flags.issue != null ? 1 : 0) +
    (flags.verify ? 1 : 0) +
    (flags.applyReview != null ? 1 : 0) +
    (flags.watch ? 1 : 0);
  if (modeCount > 1) {
    console.error(
      "--issue, --verify, --apply-review, and --watch are mutually exclusive"
    );
    process.exit(1);
  }
  if (flags.verify && !cfg.verifyStage) {
    console.error("--verify is only supported by otto-afk");
    process.exit(1);
  }
  if (flags.applyReview != null && !cfg.applyReviewStage) {
    console.error("--apply-review is only supported by otto-afk");
    process.exit(1);
  }

  const inputs =
    flags.issue != null
      ? String(flags.issue)
      : flags.applyReview != null
        ? flags.applyReview
        : cfg.takesInputArg
          ? flags.rest[0]
          : "";
  // --verify is one-shot (iterations forced to 1 below); --apply-review takes the
  // doc as its flag value, so the iterations count is the first remaining positional.
  const iterationsArg =
    flags.applyReview != null
      ? flags.rest[0]
      : cfg.takesInputArg
        ? flags.rest[1]
        : flags.rest[0];
  if (flags.verify && (!cfg.takesInputArg || !inputs)) {
    console.error(`Usage: ${cfg.bin} --verify "<plan-and-prd>"`);
    process.exit(1);
  }
  if (!flags.verify && ((cfg.takesInputArg && !inputs) || !iterationsArg)) {
    console.error(`Usage: ${cfg.bin} ${cfg.usage}`);
    console.error(`       ${cfg.bin} --help`);
    process.exit(1);
  }
  // --verify is one-shot regardless of any positional count.
  if (flags.verify && iterationsArg) {
    console.error("--verify is one-shot; ignoring the iterations argument");
  }
  const iterations = flags.verify ? 1 : Number.parseInt(iterationsArg, 10);
  if (!flags.verify && (!Number.isFinite(iterations) || iterations < 1)) {
    console.error(`Invalid iterations: ${iterationsArg}`);
    process.exit(1);
  }

  if (flags.issue != null) {
    if (flags.watch) {
      console.error("--issue cannot be combined with --watch");
      process.exit(1);
    }
    // Validated by cfg.parseIssue (GitHub positive integer / Linear ref) — both
    // admit only shell-safe chars, so it is safe for the static
    // `gh issue view "$OTTO_ISSUE"` / `otto-linear view "$OTTO_ISSUE"` commands
    // in the issue templates. See render.ts.
    process.env.OTTO_ISSUE = String(flags.issue);
  }

  const stages: [Stage, ...Stage[]] = flags.verify
    ? [cfg.verifyStage!]
    : flags.applyReview != null
      ? [cfg.applyReviewStage!, ...cfg.stages.slice(1)]
      : flags.issue != null
        ? [cfg.issueStage!, ...cfg.stages.slice(1)]
        : cfg.stages;

  if (flags.detach && detachLogPath) {
    detachAndExit({
      logPath: detachLogPath,
      argv,
      binEntry: process.argv[1],
    });
  }

  const resolved = await resolveBranch({
    workspaceDir,
    inputs,
    isTTY: Boolean(process.stdout.isTTY),
    flagStrategy: branchStrategyArg,
    flagPrefix: branchPrefixArg,
    flagConvention: branchConventionArg,
  });
  process.stderr.write(`${resolved.summaryLine}\n`);
  // Evaluate the dirty-tree warning against the user's tree BEFORE we mutate the
  // workspace's .gitignore below — otherwise Otto's own .otto-tmp/ edit would
  // make a tracked .gitignore "dirty" and fire a spurious warning on first run.
  const dirtyWarn = dirtyTreeWarning(workspaceDir, resolved.strategy);
  if (dirtyWarn) process.stderr.write(`⚠ ${dirtyWarn}\n`);

  ensureTmpIgnored(workspaceDir);

  const effectiveWorkspaceDir = resolved.effectiveWorkspaceDir;
  // state.json is written by the loop into effectiveWorkspaceDir (the worktree in
  // worktree mode), which differs from the parent workspaceDir that
  // ensureTmpIgnored targets — so this stays a separate call.
  ensureStateGitignored(effectiveWorkspaceDir);

  if (flags.watch) {
    if (!cfg.supportsWatch) {
      console.error(
        "--watch is only supported by otto-ghafk and otto-linear-afk"
      );
      process.exit(1);
    }
    const { runWatch } = await import("./watch.js");
    await runWatch({
      stages,
      iterations,
      workspaceDir: effectiveWorkspaceDir,
      packageDir,
      watchIntervalSec: flags.watchIntervalSec ?? 300,
      watchLabel,
      budgetUsd: flags.budget,
      cooldownMs: flags.cooldownMs,
      tokenMode,
      maxRetries: flags.maxRetries,
      reviewLenses,
      notify: flags.notify,
      bin: cfg.bin,
      cliVersion: cfg.cliVersion,
      pollIssues: cfg.watchPoll,
      provider: cfg.watchProvider,
      scope,
      scopes,
      agentId: agent.id,
      agentDisplayName: agent.displayName,
      fallbackAgentId: fallback.agent?.id,
      fallbackAgentDisplayName: fallback.agent?.displayName,
      autoSwitchOnLimit: fallback.autoSwitch,
    });
    return;
  }

  await runLoop({
    stages,
    inputs: inputs ?? "",
    iterations,
    workspaceDir: effectiveWorkspaceDir,
    packageDir,
    noKeepAlive: flags.noKeepAlive,
    maxRetries: flags.maxRetries,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
    budgetUsd: flags.budget,
    cooldownMs: flags.cooldownMs,
    tokenMode,
    reviewLenses,
    mode: runMode,
    maxWaitMs,
    fresh: flags.fresh,
    agentId: agent.id,
    agentDisplayName: agent.displayName,
    fallbackAgentId: fallback.agent?.id,
    fallbackAgentDisplayName: fallback.agent?.displayName,
    autoSwitchOnLimit: fallback.autoSwitch,
  });
}
