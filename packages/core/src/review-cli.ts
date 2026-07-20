/**
 * Pure P32 CLI flag parsing + config resolution for automated pull-request
 * code review. No I/O beyond reading `.otto/config.json` (readPullRequestReviewConfig)
 * — no GitHub calls, no model calls; those land in later P32 tasks.
 *
 * Reuses the existing shared-runtime validators (parseGithubRepo, parseAgentId,
 * parseTokenMode, the compressor enum) rather than reinventing them, so the
 * review CLI accepts the same flag values/error shape as the AFK CLIs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseGithubRepo } from "./task-key.js";
import { parseAgentId, type AgentRuntimeId } from "./agent-runtime.js";
import { parseTokenMode, type TokenMode } from "./tokens.js";
import type { CompressorMode } from "./context-compressor.js";

/** Primary review output surface. Default depends on mode (see resolver). */
export type ReviewOutputMode = "text" | "markdown" | "comment";

/**
 * The extra spec/context a review run is given, tagged by source. Resolved
 * only from the three invocation-only CLI flags (`--spec-issue` /
 * `--spec-file` / `--prompt`) — never from env or config. Source-specific
 * I/O (fetching the issue, reading the file) is Task 5's job; this module
 * only carries the raw reference/path/text.
 */
export type ReviewInputRequest =
  | { kind: "none" }
  | { kind: "github-issue"; ref: string }
  | { kind: "local-file"; path: string }
  | { kind: "prompt"; text: string };

/** Raw, validated flag values from argv. See resolvePullRequestReviewConfig
 *  for the flag → env → config → default precedence that builds the actual
 *  run config from these. */
export type ReviewCliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  repo?: string;
  pr?: number;
  watch: boolean;
  watchIntervalSec?: number;
  label?: string;
  reviewSkill?: string;
  specIssue?: string;
  specFile?: string;
  prompt?: string;
  output?: ReviewOutputMode;
  outputFile?: string;
  githubReview: boolean;
  agent?: AgentRuntimeId;
  fallbackAgent?: AgentRuntimeId;
  autoSwitchOnLimit: boolean;
  modelRouting: boolean;
  tokenMode?: TokenMode;
  contextCompressor?: CompressorMode;
  budget?: number;
  cooldownMs?: number;
  maxRetries?: number;
  detach: boolean;
  log?: string;
  notify: boolean;
  verbose: boolean;
};

/** The fully resolved review run configuration. */
export type PullRequestReviewConfig = {
  repository: string;
  pullRequest?: number;
  watch: boolean;
  watchIntervalSec: number;
  label: string;
  reviewSkill?: string;
  reviewInput: ReviewInputRequest;
  output: ReviewOutputMode;
  outputFile?: string;
  githubReview: boolean;
};

const PR_URL_RE =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * The largest delay Node's timer subsystem accepts before it silently CLAMPS to
 * 1ms (`2^31 - 1` ms ≈ 24.8 days). A timer-backed CLI value (watch interval,
 * cooldown) that exceeds this — or that is not a safe integer — must be REJECTED
 * with an actionable flag error, never handed to `setTimeout` where the clamp
 * would turn an intended long wait into hot polling.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Normalize a `--pr` value to a positive PR number. Accepts a bare positive
 * integer (`[1-9]\d*`) or a GitHub PR URL. When `repository` (an `owner/name`
 * scope, e.g. the `--repo` value) is given and the input is a URL, the URL's
 * owner/repo is compared case-insensitively against it; a mismatch throws.
 */
export function parsePullRequestRef(raw: string, repository?: string): number {
  const s = raw.trim();
  let numStr: string;
  let urlOwner: string | undefined;
  let urlRepo: string | undefined;

  if (/^[1-9]\d*$/.test(s)) {
    numStr = s;
  } else {
    const m = s.match(PR_URL_RE);
    if (!m) {
      throw new Error(
        `--pr must be a positive integer or a GitHub PR URL, got: ${JSON.stringify(raw)}`
      );
    }
    urlOwner = m[1];
    urlRepo = m[2];
    numStr = m[3];
  }

  const n = Number.parseInt(numStr, 10);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`--pr number is too large, got: ${JSON.stringify(raw)}`);
  }

  if (urlOwner !== undefined && urlRepo !== undefined && repository) {
    const slash = repository.indexOf("/");
    const rOwner = slash >= 0 ? repository.slice(0, slash) : repository;
    const rRepo = slash >= 0 ? repository.slice(slash + 1) : "";
    if (
      urlOwner.toLowerCase() !== rOwner.toLowerCase() ||
      urlRepo.toLowerCase() !== rRepo.toLowerCase()
    ) {
      throw new Error(
        `--pr URL repository (${urlOwner}/${urlRepo}) does not match --repo ${repository}`
      );
    }
  }

  return n;
}

/**
 * Parse review-CLI argv into validated flags. Every value flag consumes
 * exactly one following token; booleans consume none. Structural
 * cross-flag requirements (repo required, exactly one of --pr/--watch,
 * --output-file needing markdown, --detach/--watch-interval needing --watch,
 * --log needing --detach, review-input exclusivity, empty --prompt) are
 * deferred to {@link resolvePullRequestReviewConfig} — this function only
 * validates each flag's own value (format/enum/range) and requires that a
 * value-flag has a following token. Unknown flags and stray positional
 * arguments both throw (this CLI has no passthrough `rest`).
 */
export function parseReviewFlags(argv: string[]): ReviewCliFlags {
  let help = false;
  let version = false;
  let printConfig = false;
  let repo: string | undefined;
  let expectingRepo = false;
  let prRaw: string | undefined;
  let expectingPr = false;
  let watch = false;
  let watchIntervalSec: number | undefined;
  let expectingWatchInterval = false;
  let label: string | undefined;
  let expectingLabel = false;
  let reviewSkill: string | undefined;
  let expectingReviewSkill = false;
  let specIssue: string | undefined;
  let expectingSpecIssue = false;
  let specFile: string | undefined;
  let expectingSpecFile = false;
  let prompt: string | undefined;
  let expectingPrompt = false;
  let output: ReviewOutputMode | undefined;
  let expectingOutput = false;
  let outputFile: string | undefined;
  let expectingOutputFile = false;
  let githubReview = false;
  let agent: AgentRuntimeId | undefined;
  let expectingAgent = false;
  let fallbackAgent: AgentRuntimeId | undefined;
  let expectingFallbackAgent = false;
  let autoSwitchOnLimit = false;
  let modelRouting = false;
  let tokenMode: TokenMode | undefined;
  let expectingTokenMode = false;
  let contextCompressor: CompressorMode | undefined;
  let expectingContextCompressor = false;
  let budget: number | undefined;
  let expectingBudget = false;
  let cooldownMs: number | undefined;
  let expectingCooldown = false;
  let maxRetries: number | undefined;
  let expectingMaxRetries = false;
  let detach = false;
  let log: string | undefined;
  let expectingLog = false;
  let notify = false;
  let verbose = false;

  for (const a of argv) {
    if (expectingRepo) {
      const { owner, repo: name } = parseGithubRepo(a);
      repo = `${owner}/${name}`;
      expectingRepo = false;
      continue;
    }
    if (expectingPr) {
      prRaw = a;
      expectingPr = false;
      continue;
    }
    if (expectingWatchInterval) {
      const n = Number.parseInt(a, 10);
      if (!/^\d+$/.test(a) || !Number.isSafeInteger(n) || n <= 0) {
        throw new Error(
          `--watch-interval must be a positive integer (seconds), got: ${JSON.stringify(a)}`
        );
      }
      // The interval is fed to setTimeout as milliseconds; reject a value whose
      // ms would exceed Node's max timer delay (it would otherwise clamp to 1ms
      // and hot-poll) instead of letting Node silently mangle it.
      if (n * 1000 > MAX_TIMER_DELAY_MS) {
        throw new Error(
          `--watch-interval is too large (max ${Math.floor(MAX_TIMER_DELAY_MS / 1000)} seconds), got: ${JSON.stringify(a)}`
        );
      }
      watchIntervalSec = n;
      expectingWatchInterval = false;
      continue;
    }
    if (expectingLabel) {
      label = a;
      expectingLabel = false;
      continue;
    }
    if (expectingReviewSkill) {
      reviewSkill = a;
      expectingReviewSkill = false;
      continue;
    }
    if (expectingSpecIssue) {
      specIssue = a;
      expectingSpecIssue = false;
      continue;
    }
    if (expectingSpecFile) {
      specFile = a;
      expectingSpecFile = false;
      continue;
    }
    if (expectingPrompt) {
      prompt = a;
      expectingPrompt = false;
      continue;
    }
    if (expectingOutput) {
      if (a !== "text" && a !== "markdown" && a !== "comment") {
        throw new Error(
          `--output must be one of text|markdown|comment, got: ${JSON.stringify(a)}`
        );
      }
      output = a;
      expectingOutput = false;
      continue;
    }
    if (expectingOutputFile) {
      outputFile = a;
      expectingOutputFile = false;
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
    if (expectingTokenMode) {
      tokenMode = parseTokenMode(a, "--token-mode");
      expectingTokenMode = false;
      continue;
    }
    if (expectingContextCompressor) {
      if (a !== "off" && a !== "headroom") {
        throw new Error(
          `--context-compressor must be "off" or "headroom", got: ${JSON.stringify(a)}`
        );
      }
      contextCompressor = a;
      expectingContextCompressor = false;
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
      const n = Number.parseInt(a, 10);
      if (!/^\d+$/.test(a) || !Number.isSafeInteger(n)) {
        throw new Error(
          `--cooldown must be a non-negative integer (ms), got: ${JSON.stringify(a)}`
        );
      }
      // The cooldown is a setTimeout delay; reject an overflow that Node would
      // clamp to 1ms rather than letting it hot-loop.
      if (n > MAX_TIMER_DELAY_MS) {
        throw new Error(
          `--cooldown is too large (max ${MAX_TIMER_DELAY_MS} ms), got: ${JSON.stringify(a)}`
        );
      }
      cooldownMs = n;
      expectingCooldown = false;
      continue;
    }
    if (expectingMaxRetries) {
      // Match the shared CLI contract (cli-help.ts): a non-negative SAFE integer.
      // `--max-retries 0` is a VALID fail-fast value (disable retries), not an
      // error. A non-safe-integer (overflow) is rejected with an actionable error.
      const n = Number.parseInt(a, 10);
      if (!/^\d+$/.test(a) || !Number.isSafeInteger(n)) {
        throw new Error(
          `--max-retries must be a non-negative integer, got: ${JSON.stringify(a)}`
        );
      }
      maxRetries = n;
      expectingMaxRetries = false;
      continue;
    }
    if (expectingLog) {
      log = a;
      expectingLog = false;
      continue;
    }

    switch (a) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-V":
      case "--version":
        version = true;
        break;
      case "--print-config":
        printConfig = true;
        break;
      case "--repo":
        expectingRepo = true;
        break;
      case "--pr":
        expectingPr = true;
        break;
      case "--watch":
        watch = true;
        break;
      case "--watch-interval":
        expectingWatchInterval = true;
        break;
      case "--label":
        expectingLabel = true;
        break;
      case "--review-skill":
        expectingReviewSkill = true;
        break;
      case "--spec-issue":
        expectingSpecIssue = true;
        break;
      case "--spec-file":
        expectingSpecFile = true;
        break;
      case "--prompt":
        expectingPrompt = true;
        break;
      case "--output":
        expectingOutput = true;
        break;
      case "--output-file":
        expectingOutputFile = true;
        break;
      case "--github-review":
        githubReview = true;
        break;
      case "--agent":
        expectingAgent = true;
        break;
      case "--fallback-agent":
        expectingFallbackAgent = true;
        break;
      case "--auto-switch-on-limit":
        autoSwitchOnLimit = true;
        break;
      case "--model-routing":
        modelRouting = true;
        break;
      case "--token-mode":
        expectingTokenMode = true;
        break;
      case "--context-compressor":
        expectingContextCompressor = true;
        break;
      case "--budget":
        expectingBudget = true;
        break;
      case "--cooldown":
        expectingCooldown = true;
        break;
      case "--max-retries":
        expectingMaxRetries = true;
        break;
      case "--detach":
        detach = true;
        break;
      case "--log":
        expectingLog = true;
        break;
      case "--notify":
        notify = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      default:
        throw new Error(
          a.startsWith("-")
            ? `unknown flag: ${a}`
            : `unexpected argument: ${JSON.stringify(a)}`
        );
    }
  }

  if (expectingRepo) throw new Error("--repo requires a value");
  if (expectingPr) throw new Error("--pr requires a value");
  if (expectingWatchInterval)
    throw new Error("--watch-interval requires a value");
  if (expectingLabel) throw new Error("--label requires a value");
  if (expectingReviewSkill) throw new Error("--review-skill requires a value");
  if (expectingSpecIssue) throw new Error("--spec-issue requires a value");
  if (expectingSpecFile) throw new Error("--spec-file requires a value");
  if (expectingPrompt) throw new Error("--prompt requires a value");
  if (expectingOutput) throw new Error("--output requires a value");
  if (expectingOutputFile) throw new Error("--output-file requires a value");
  if (expectingAgent) throw new Error("--agent requires a value");
  if (expectingFallbackAgent)
    throw new Error("--fallback-agent requires a value");
  if (expectingTokenMode) throw new Error("--token-mode requires a value");
  if (expectingContextCompressor)
    throw new Error("--context-compressor requires a value");
  if (expectingBudget) throw new Error("--budget requires a value");
  if (expectingCooldown) throw new Error("--cooldown requires a value");
  if (expectingMaxRetries) throw new Error("--max-retries requires a value");
  if (expectingLog) throw new Error("--log requires a value");

  const pr = prRaw !== undefined ? parsePullRequestRef(prRaw, repo) : undefined;

  return {
    help,
    version,
    printConfig,
    repo,
    pr,
    watch,
    watchIntervalSec,
    label,
    reviewSkill,
    specIssue,
    specFile,
    prompt,
    output,
    outputFile,
    githubReview,
    agent,
    fallbackAgent,
    autoSwitchOnLimit,
    modelRouting,
    tokenMode,
    contextCompressor,
    budget,
    cooldownMs,
    maxRetries,
    detach,
    log,
    notify,
    verbose,
  };
}

/**
 * Read the `.otto/config.json` `pullRequestReview` block for a workspace, as
 * raw `unknown` (validated + narrowed by resolvePullRequestReviewConfig).
 * Missing/unreadable/malformed file → `undefined` (never throws).
 */
export function readPullRequestReviewConfig(workspaceDir: string): unknown {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    return raw.pullRequestReview;
  } catch {
    return undefined;
  }
}

/** Trim; treat "" (and non-strings) as absent. */
function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function isReviewOutputMode(v: unknown): v is ReviewOutputMode {
  return v === "text" || v === "markdown" || v === "comment";
}

/**
 * Resolve the full review run config from parsed flags + env + the raw
 * `pullRequestReview` config block (see readPullRequestReviewConfig).
 * `config` is validated here: non-object/array values are treated as `{}`,
 * and individual fields are ignored unless they are the expected type.
 *
 * Precedence for `label`/`reviewSkill`/`output`: flag > env > config >
 * default. `repository` and the review input are invocation-only (flag only
 * — no env/config fallback). `githubReview` is flag-or-config (no env); the
 * positive flag always wins, a `false` config value leaves it disabled.
 *
 * Throws on: missing --repo, not-exactly-one-of --pr/--watch, --output-file
 * without --output markdown, --watch-interval/--detach without --watch,
 * --log without --detach, more than one of --spec-issue/--spec-file/--prompt,
 * and a whitespace-only --prompt.
 */
export function resolvePullRequestReviewConfig(opts: {
  flags: ReviewCliFlags;
  env: NodeJS.ProcessEnv;
  config: unknown;
}): PullRequestReviewConfig {
  const { flags, env, config } = opts;
  const cfg: Record<string, unknown> =
    config != null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};

  if (!flags.repo) {
    throw new Error("--repo owner/name is required");
  }
  const { owner, repo: name } = parseGithubRepo(flags.repo);
  const repository = `${owner.toLowerCase()}/${name.toLowerCase()}`;

  const hasPr = flags.pr !== undefined;
  if (hasPr === flags.watch) {
    throw new Error("exactly one of --pr or --watch is required");
  }

  if (flags.watchIntervalSec !== undefined && !flags.watch) {
    throw new Error("--watch-interval is only valid with --watch");
  }
  if (flags.detach && !flags.watch) {
    throw new Error("--detach is only valid with --watch");
  }
  if (flags.log !== undefined && !flags.detach) {
    throw new Error("--log is only valid with --detach");
  }

  const specCount = [flags.specIssue, flags.specFile, flags.prompt].filter(
    (v) => v !== undefined
  ).length;
  if (specCount > 1) {
    throw new Error(
      "at most one of --spec-issue, --spec-file, or --prompt may be used"
    );
  }
  let reviewInput: ReviewInputRequest = { kind: "none" };
  if (flags.specIssue !== undefined) {
    reviewInput = { kind: "github-issue", ref: flags.specIssue };
  } else if (flags.specFile !== undefined) {
    reviewInput = { kind: "local-file", path: flags.specFile };
  } else if (flags.prompt !== undefined) {
    if (flags.prompt.trim().length === 0) {
      throw new Error("--prompt must not be empty");
    }
    reviewInput = { kind: "prompt", text: flags.prompt };
  }

  const label =
    flags.label ??
    nonEmptyString(env.OTTO_REVIEW_LABEL) ??
    nonEmptyString(cfg.label) ??
    "otto-review";

  const reviewSkill =
    flags.reviewSkill ??
    nonEmptyString(env.OTTO_REVIEW_SKILL) ??
    nonEmptyString(cfg.skill);

  const outputRaw =
    flags.output ??
    nonEmptyString(env.OTTO_REVIEW_OUTPUT) ??
    nonEmptyString(cfg.output);
  let output: ReviewOutputMode;
  if (outputRaw === undefined) {
    output = flags.watch ? "comment" : "text";
  } else if (isReviewOutputMode(outputRaw)) {
    output = outputRaw;
  } else {
    throw new Error(
      `--output must be one of text|markdown|comment, got: ${JSON.stringify(outputRaw)}`
    );
  }

  if (flags.outputFile !== undefined && output !== "markdown") {
    throw new Error("--output-file requires --output markdown");
  }

  const githubReview = flags.githubReview ? true : cfg.githubReview === true;

  return {
    repository,
    pullRequest: flags.pr,
    watch: flags.watch,
    watchIntervalSec: flags.watchIntervalSec ?? 300,
    label,
    reviewSkill,
    reviewInput,
    output,
    outputFile: flags.outputFile,
    githubReview,
  };
}

/** `--help` text for the review CLI entry point (bin defaults to "otto-review"). */
export function formatReviewHelp(bin = "otto-review"): string {
  return `${bin} — automated pull-request code review

Usage:
  ${bin} --repo <owner/name> --pr <number|url> [flags]
  ${bin} --repo <owner/name> --watch [flags]
  ${bin} --help | -h
  ${bin} --version | -V
  ${bin} --print-config [args...]

Flags:
  -h, --help              show this help and exit
  -V, --version           print bin + core version and exit
  --print-config          print the resolved review config, then exit
  --repo <owner/name>     GitHub repository to review (required)
  --pr <n|url>            pull request number or GitHub PR URL (exactly one of --pr/--watch)
  --watch                 poll for eligible PRs instead of reviewing one (exactly one of --pr/--watch)
  --watch-interval <sec>  seconds between polls in watch mode (default: 300; only valid with --watch)
  --label <name>          label a PR must carry to be eligible (or OTTO_REVIEW_LABEL; default: otto-review)
  --review-skill <name>   named review skill to apply (or OTTO_REVIEW_SKILL; default: none)
  --spec-issue <ref>      spec/context from a GitHub issue (at most one of --spec-issue/--spec-file/--prompt)
  --spec-file <path>      spec/context from a local file (at most one of --spec-issue/--spec-file/--prompt)
  --prompt <text>         spec/context from a direct prompt (at most one of --spec-issue/--spec-file/--prompt)
  --output <mode>         text | markdown | comment (or OTTO_REVIEW_OUTPUT; default: text one-shot, comment in --watch)
  --output-file <path>    write markdown output to this path (requires --output markdown)
  --github-review         post the outcome as a native GitHub PR review (default: off)
  --agent <runtime>       agent CLI runtime: claude | codex (default: claude)
  --fallback-agent <runtime>  runtime to switch to on a usage/rate limit
  --auto-switch-on-limit  switch to the fallback runtime when the active one hits a limit
  --model-routing         route each stage to a model tier by difficulty + change risk
  --token-mode <mode>     token accounting mode: off | measure | reduce
  --context-compressor <mode>  off | headroom
  --budget <usd>          stop when cumulative cost reaches this USD ceiling
  --cooldown <ms>         wait this many milliseconds between iterations
  --max-retries <n>       per-stage retry budget on transient failure (0 disables retries)
  --detach                fork into a background process (only valid with --watch)
  --log <path>            override the detached log path (only valid with --detach)
  --notify                emit OS notification + terminal bell on completion
  --verbose               print the full in-run event firehose

Environment variables:
  OTTO_REVIEW_LABEL    default label; same as --label
  OTTO_REVIEW_SKILL    default review skill; same as --review-skill
  OTTO_REVIEW_OUTPUT   default output mode; same as --output
`;
}

function formatReviewInput(input: ReviewInputRequest): string {
  switch (input.kind) {
    case "none":
      return "none";
    case "github-issue":
      return `issue ${input.ref}`;
    case "local-file":
      return `file ${input.path}`;
    case "prompt":
      // Never echo prompt content — only its length.
      return `direct (${input.text.length} chars)`;
  }
}

/**
 * Render a resolved review config for `--print-config`. Never reveals a
 * direct-prompt's text — only its character count via formatReviewInput.
 */
export function formatReviewConfig(config: PullRequestReviewConfig): string {
  const prStatus =
    config.pullRequest != null ? `#${config.pullRequest}` : "n/a";
  const watchStatus = config.watch
    ? `on (every ${config.watchIntervalSec}s)`
    : "off";
  const outputFileStatus = config.outputFile
    ? ` (file: ${config.outputFile})`
    : "";
  return `pull-request review config
  repository        ${config.repository}
  pull request      ${prStatus}
  watch             ${watchStatus}
  label             ${config.label}
  review skill      ${config.reviewSkill ?? "default"}
  review input      ${formatReviewInput(config.reviewInput)}
  output            ${config.output}${outputFileStatus}
  github review     ${config.githubReview ? "on" : "off"}
`;
}
