import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  git,
  hasUncommittedTrackedChanges,
  isGitRepo,
  refExists,
} from "./git.js";

export type BranchStrategy = "current" | "branch" | "worktree";

export type BranchConfig = {
  branchStrategy?: BranchStrategy;
  branchPrefix?: string;
  /**
   * Validated, slash-normalized branch namespace (`<convention>/<slug>`). The
   * canonical replacement for the raw `branchPrefix`: it is git-ref-safe and
   * always ends in a single `/`. Takes precedence over `branchPrefix`.
   */
  branchConvention?: string;
};

export type ResolvedBranch = {
  strategy: BranchStrategy;
  branchName: string | null;
  effectiveWorkspaceDir: string;
  worktreePath?: string;
  summaryLine: string;
};

export type BranchPromptResult = {
  strategy: BranchStrategy;
  remember: boolean;
};

export type ResolveBranchOptions = {
  workspaceDir: string;
  inputs: string;
  isTTY: boolean;
  flagStrategy?: BranchStrategy;
  flagPrefix?: string;
  /**
   * Validated branch convention (e.g. `feat`, `feature`, `fix`). When set it is
   * normalized to `<convention>/` and used as the branch namespace, taking
   * precedence over `flagPrefix`/config. See {@link normalizeBranchConvention}.
   */
  flagConvention?: string;
  /** Injectable for tests; defaults to a readline prompt. Only called when isTTY && unresolved. */
  prompt?: () => Promise<BranchPromptResult>;
  /** Injectable clock for the timestamp slug (test seam). */
  now?: () => string;
};

const DEFAULT_PREFIX = "otto/";
const CONFIG_REL = join(".otto", "config.json");

/**
 * Derive a branch slug from an inputs string. Uses the basename (sans extension)
 * of the first whitespace-separated token, lowercased, with non-alphanumerics
 * collapsed to single dashes and capped at 40 chars. "" when there is nothing usable.
 */
export function slugify(inputs: string): string {
  const first = inputs.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  const baseName = basename(first).replace(/\.[^.]+$/, "");
  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Validate + normalize a user-supplied branch convention into a `<convention>/`
 * namespace. Trims whitespace, strips an optional trailing slash (so `feat` and
 * `feat/` both yield `feat/`), and rejects anything that would not be git-ref-safe
 * (whitespace, `..`, leading `-`/`.`, empty segments, `.lock` suffix, or git ref
 * metacharacters). Throws on an empty or unsafe value.
 */
export function normalizeBranchConvention(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error(
      `branch convention must be a non-empty name (e.g. "feat", "otto"), got: ${JSON.stringify(raw)}`
    );
  }
  const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const segment of trimmed.split("/")) {
    if (
      !safeSegment.test(segment) ||
      segment.includes("..") ||
      segment.endsWith(".lock")
    ) {
      throw new Error(
        `branch convention has an unsafe path segment ${JSON.stringify(segment)}; use letters, digits, ".", "_", "-" (e.g. "feat", "feature", "team/feat"), got: ${JSON.stringify(raw)}`
      );
    }
  }
  return `${trimmed}/`;
}

/** Read .otto/config.json. Absent or malformed → {} (never throws). */
export function readBranchConfig(workspaceDir: string): BranchConfig {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, CONFIG_REL), "utf8")
    ) as Record<string, unknown>;
    const out: BranchConfig = {};
    if (
      raw.branchStrategy === "current" ||
      raw.branchStrategy === "branch" ||
      raw.branchStrategy === "worktree"
    ) {
      out.branchStrategy = raw.branchStrategy;
    }
    if (typeof raw.branchPrefix === "string")
      out.branchPrefix = raw.branchPrefix;
    if (typeof raw.branchConvention === "string")
      out.branchConvention = raw.branchConvention;
    return out;
  } catch {
    return {};
  }
}

/** Merge `patch` into .otto/config.json, preserving unknown keys. Creates .otto/ if needed. */
export function writeBranchConfig(
  workspaceDir: string,
  patch: BranchConfig
): void {
  const path = join(workspaceDir, CONFIG_REL);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    existing = {};
  }
  mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...existing, ...patch }, null, 2) + "\n"
  );
}

/** Default readline prompt (only used in a TTY). */
async function defaultPrompt(): Promise<BranchPromptResult> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (
      await rl.question("Branch strategy [current/branch/worktree] (current): ")
    )
      .trim()
      .toLowerCase();
    const strategy: BranchStrategy =
      ans === "branch" || ans === "worktree" ? ans : "current";
    let remember = false;
    if (strategy !== "current") {
      const r = (await rl.question("Remember for this repo? [y/N]: "))
        .trim()
        .toLowerCase();
      remember = r === "y" || r === "yes";
    }
    return { strategy, remember };
  } finally {
    rl.close();
  }
}

function defaultNow(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Append -2, -3, … until the branch name is free. */
function uniqueBranchName(workspaceDir: string, name: string): string {
  if (!refExists(workspaceDir, name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!refExists(workspaceDir, candidate)) return candidate;
  }
}

/**
 * Resolve the branch strategy once at startup and perform its one-time git side
 * effect. Precedence: flagStrategy → .otto/config.json → TTY prompt → "current".
 * Returns the effective workspace dir the loop should run in (the worktree path
 * in worktree mode, else the original workspaceDir).
 */
export async function resolveBranch(
  opts: ResolveBranchOptions
): Promise<ResolvedBranch> {
  const { workspaceDir, inputs, isTTY } = opts;
  const now = opts.now ?? defaultNow;
  const config = readBranchConfig(workspaceDir);
  // Branch namespace precedence: flags beat config, and the validated convention
  // beats the raw prefix at each level. The convention is the canonical name; the
  // prefix is kept as a back-compat fallback.
  const prefix =
    opts.flagConvention !== undefined
      ? normalizeBranchConvention(opts.flagConvention)
      : opts.flagPrefix !== undefined
        ? opts.flagPrefix
        : config.branchConvention !== undefined
          ? normalizeBranchConvention(config.branchConvention)
          : (config.branchPrefix ?? DEFAULT_PREFIX);

  let strategy: BranchStrategy;
  if (opts.flagStrategy) {
    strategy = opts.flagStrategy;
  } else if (config.branchStrategy) {
    strategy = config.branchStrategy;
  } else if (isTTY) {
    const res = await (opts.prompt ?? defaultPrompt)();
    strategy = res.strategy;
    if (res.remember && strategy !== "current") {
      writeBranchConfig(workspaceDir, {
        branchStrategy: strategy,
        branchPrefix: prefix,
      });
    }
  } else {
    strategy = "current";
  }

  if (strategy === "current") {
    return {
      strategy,
      branchName: null,
      effectiveWorkspaceDir: workspaceDir,
      summaryLine:
        "branch strategy: current (committing on the current branch)",
    };
  }

  if (!isGitRepo(workspaceDir)) {
    throw new Error(
      `branch strategy "${strategy}" requires a git repo, but ${workspaceDir} is not a git work tree`
    );
  }

  const slug = slugify(inputs) || now();
  const branchName = uniqueBranchName(workspaceDir, prefix + slug);

  if (strategy === "branch") {
    const current = git(["branch", "--show-current"], workspaceDir);
    if (current === branchName) {
      return {
        strategy,
        branchName,
        effectiveWorkspaceDir: workspaceDir,
        summaryLine: `branch strategy: branch (already on ${branchName})`,
      };
    }
    execFileSync("git", ["switch", "-c", branchName], {
      cwd: workspaceDir,
      stdio: "ignore",
    });
    return {
      strategy,
      branchName,
      effectiveWorkspaceDir: workspaceDir,
      summaryLine: `branch strategy: branch (created + switched to ${branchName})`,
    };
  }

  // worktree
  const worktreePath = join(workspaceDir, ".otto-tmp", "worktrees", slug);
  mkdirSync(join(workspaceDir, ".otto-tmp", "worktrees"), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: workspaceDir, stdio: "ignore" }
  );
  const dirtyNote = hasUncommittedTrackedChanges(workspaceDir)
    ? " (uncommitted changes left in the main checkout)"
    : "";
  return {
    strategy,
    branchName,
    effectiveWorkspaceDir: worktreePath,
    worktreePath,
    summaryLine: `branch strategy: worktree (${branchName} at ${worktreePath})${dirtyNote}`,
  };
}

/**
 * Ensure `.otto-tmp/` is gitignored in the workspace. No-op outside a git repo
 * or when a `.otto-tmp` entry already exists. Creates .gitignore if absent.
 * Never ignores `.otto/` (LEARNINGS.md + config.json are durable, git-tracked
 * memory).
 *
 * Idempotency is checked by scanning .gitignore text — NOT `git check-ignore`,
 * which only matches a trailing-slash dir pattern once the dir exists on disk.
 */
export function ensureTmpIgnored(workspaceDir: string): void {
  if (!isGitRepo(workspaceDir)) return;
  const path = join(workspaceDir, ".gitignore");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const already = text
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === ".otto-tmp" || l === ".otto-tmp/");
  if (already) return;
  const needsNl = text.length > 0 && !text.endsWith("\n");
  appendFileSync(path, `${needsNl ? "\n" : ""}.otto-tmp/\n`);
}

/**
 * Returns a warning string if `strategy` keeps work in the current checkout AND
 * the tree has uncommitted tracked changes (which disables the review panel's
 * read-only reset enforcement). null when there is nothing to warn about.
 */
export function dirtyTreeWarning(
  workspaceDir: string,
  strategy: BranchStrategy
): string | null {
  if (strategy === "worktree") return null; // worktree starts clean by construction
  if (!isGitRepo(workspaceDir)) return null;
  if (!hasUncommittedTrackedChanges(workspaceDir)) return null;
  return "working tree has uncommitted changes — review-panel read-only enforcement will be disabled; consider committing/stashing or using --branch worktree";
}
