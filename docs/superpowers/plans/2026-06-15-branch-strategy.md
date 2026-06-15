# Branch Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AFK bins isolate Otto's work onto a new branch or git worktree (chosen once per run via flag → learned config → TTY prompt → safe default), plus auto-ignore `.otto-tmp/` and warn on a dirty tree.

**Architecture:** A new `branch.ts` module resolves a `BranchStrategy` and performs the one-time git side-effect before the loop starts, returning the `effectiveWorkspaceDir` that `run-bin.ts` then threads into `runLoop`/`runWatch` unchanged. A small shared `git.ts` holds the low-level `git()` runner + repo/dirty/ignore predicates (extracted from `panel.ts` so there's one git invocation). Everything downstream (runner cwd, reviewer, panel, spill, `.otto/`) inherits the effective dir for free.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), vitest, `node:child_process` `execFileSync` (no shell), `node:readline/promises` for the prompt.

Spec: `docs/superpowers/specs/2026-06-15-branch-strategy-design.md`.

**Conventions reminder:** ESM-only, relative imports end in `.js`. `pnpm -r build` after editing `packages/core` before any `--print-config` smoke (the cli imports `dist/`). Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`.

---

## File Structure

- **Create** `packages/core/src/git.ts` — low-level `git(args, cwd)` + `isGitRepo`, `hasUncommittedTrackedChanges`, `isPathIgnored`, `refExists`. Single owner of `execFileSync("git", …)`.
- **Create** `packages/core/src/branch.ts` — `BranchStrategy`, `ResolvedBranch`, `slugify`, `readBranchConfig`/`writeBranchConfig`, `resolveBranch`, `ensureTmpIgnored`, `dirtyTreeWarning`.
- **Create** `packages/core/src/__tests__/git.test.ts`, `packages/core/src/__tests__/branch.test.ts`.
- **Modify** `packages/core/src/panel.ts` — replace its private `git()` with an import from `./git.js` (no behaviour change).
- **Modify** `packages/core/src/cli-help.ts` — add `--branch` / `--branch-prefix` parsing, help text, `--print-config` lines.
- **Modify** `packages/core/src/run-bin.ts` — read `OTTO_BRANCH`/`OTTO_BRANCH_PREFIX`, call `resolveBranch` after the detach fork, thread `effectiveWorkspaceDir` into `runWatch`/`runLoop`, call `ensureTmpIgnored` + `dirtyTreeWarning`, print summary.
- **Modify** `README.md`, `docs/ARCHITECTURE.md` — document the flags/env/file.

`apps/cli` bins (`main.ts`/`gh-main.ts`) need **no** change — flags flow through `parseFlags` + `runBin`.

---

## Task 1: Shared `git.ts` helper (extract from panel)

**Files:**

- Create: `packages/core/src/git.ts`
- Create: `packages/core/src/__tests__/git.test.ts`
- Modify: `packages/core/src/panel.ts:90-104` (remove private `git`, import shared one)

- [ ] **Step 1: Write the failing test**

`packages/core/src/__tests__/git.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  git,
  hasUncommittedTrackedChanges,
  isGitRepo,
  isPathIgnored,
  refExists,
} from "../git.js";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "1");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("git helpers", () => {
  it("isGitRepo true in a repo, false outside", () => {
    const dir = tmpRepo();
    expect(isGitRepo(dir)).toBe(true);
    expect(isGitRepo(tmpdir())).toBe(false);
  });

  it("detects uncommitted tracked changes only", () => {
    const dir = tmpRepo();
    expect(hasUncommittedTrackedChanges(dir)).toBe(false);
    writeFileSync(join(dir, "untracked.txt"), "x"); // untracked → ignored
    expect(hasUncommittedTrackedChanges(dir)).toBe(false);
    writeFileSync(join(dir, "a.txt"), "2"); // tracked edit → dirty
    expect(hasUncommittedTrackedChanges(dir)).toBe(true);
  });

  it("isPathIgnored reflects .gitignore", () => {
    const dir = tmpRepo();
    expect(isPathIgnored(dir, ".otto-tmp")).toBe(false);
    writeFileSync(join(dir, ".gitignore"), ".otto-tmp/\n");
    expect(isPathIgnored(dir, ".otto-tmp")).toBe(true);
  });

  it("refExists distinguishes existing from missing branches", () => {
    const dir = tmpRepo();
    expect(refExists(dir, "nope")).toBe(false);
    execFileSync("git", ["branch", "feature"], { cwd: dir });
    expect(refExists(dir, "feature")).toBe(true);
  });

  it("git() returns null on failure instead of throwing", () => {
    expect(git(["rev-parse", "HEAD"], tmpdir())).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- git.test`
Expected: FAIL — cannot find module `../git.js`.

- [ ] **Step 3: Write `git.ts`**

```ts
import { execFileSync } from "node:child_process";

/**
 * Run git with literal args (no shell — args never interpolate runtime data).
 * Returns trimmed stdout, or null on any non-zero exit / missing repo.
 */
export function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/** True if any TRACKED file has uncommitted changes (untracked files ignored). */
export function hasUncommittedTrackedChanges(cwd: string): boolean {
  const s = git(["status", "--porcelain", "--untracked-files=no"], cwd);
  return s != null && s !== "";
}

/** True if `relPath` is gitignored in `cwd`. */
export function isPathIgnored(cwd: string, relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** True if a local branch/ref named `name` already exists. */
export function refExists(cwd: string, name: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      {
        cwd,
        stdio: "ignore",
      }
    );
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Rewire `panel.ts`** — delete its private `git` function (the `function git(args, workspaceDir) { … }` block at `panel.ts:90-104`) and add to the import group at the top:

```ts
import { git } from "./git.js";
```

Leave `trackedStatus`, `worktreeDirty`, `lensMutatedRepo` as-is — they call the now-imported `git` (note: panel's helpers pass `workspaceDir` positionally, which matches `git(args, cwd)`).

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- git.test panel.test && pnpm -r typecheck`
Expected: PASS (git.test green, panel.test still green, typecheck clean).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/git.ts packages/core/src/__tests__/git.test.ts packages/core/src/panel.ts
git commit -m "refactor(core): extract shared git helpers into git.ts"
```

---

## Task 2: `slugify` in `branch.ts`

**Files:**

- Create: `packages/core/src/branch.ts`
- Create: `packages/core/src/__tests__/branch.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/__tests__/branch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slugify } from "../branch.js";

describe("slugify", () => {
  it("takes the basename of the first path token, drops extension", () => {
    expect(slugify("docs/2026-06-15-analytics.md other.md")).toBe(
      "2026-06-15-analytics"
    );
  });
  it("lowercases, collapses non-alnum to single dashes, trims", () => {
    expect(slugify("Feature: Add  Login!!.md")).toBe("feature-add-login");
  });
  it("caps length at 40 chars without trailing dash", () => {
    const s = slugify("a".repeat(60) + ".md");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: FAIL — cannot find module `../branch.js`.

- [ ] **Step 3: Write `slugify` in `branch.ts`**

```ts
import { basename } from "node:path";

/**
 * Derive a branch slug from an inputs string. Uses the basename (sans extension)
 * of the first whitespace-separated token, lowercased, with non-alphanumerics
 * collapsed to single dashes and capped at 40 chars. "" when there is nothing usable.
 */
export function slugify(inputs: string): string {
  const first = inputs.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  const base = basename(first).replace(/\.[^.]+$/, "");
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/branch.ts packages/core/src/__tests__/branch.test.ts
git commit -m "feat(core): add slugify for branch naming"
```

---

## Task 3: `.otto/config.json` read/write

**Files:**

- Modify: `packages/core/src/branch.ts`
- Modify: `packages/core/src/__tests__/branch.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `branch.test.ts`:

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBranchConfig, writeBranchConfig } from "../branch.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "otto-cfg-"));
}

describe("branch config", () => {
  it("returns empty object when .otto/config.json is absent", () => {
    expect(readBranchConfig(tmpDir())).toEqual({});
  });
  it("returns empty object on malformed JSON (never throws)", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".otto"));
    writeFileSync(join(dir, ".otto", "config.json"), "{ not json");
    expect(readBranchConfig(dir)).toEqual({});
  });
  it("round-trips a written config", () => {
    const dir = tmpDir();
    writeBranchConfig(dir, {
      branchStrategy: "worktree",
      branchPrefix: "otto/",
    });
    expect(readBranchConfig(dir)).toEqual({
      branchStrategy: "worktree",
      branchPrefix: "otto/",
    });
  });
  it("merges into an existing config, preserving unknown keys", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".otto"));
    writeFileSync(
      join(dir, ".otto", "config.json"),
      JSON.stringify({ extra: 1 })
    );
    writeBranchConfig(dir, { branchStrategy: "branch" });
    const raw = JSON.parse(
      readFileSync(join(dir, ".otto", "config.json"), "utf8")
    );
    expect(raw.extra).toBe(1);
    expect(raw.branchStrategy).toBe("branch");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: FAIL — `readBranchConfig` / `writeBranchConfig` not exported.

- [ ] **Step 3: Implement in `branch.ts`** (add imports + code)

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BranchStrategy = "current" | "branch" | "worktree";

export type BranchConfig = {
  branchStrategy?: BranchStrategy;
  branchPrefix?: string;
};

const CONFIG_REL = join(".otto", "config.json");

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
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/branch.ts packages/core/src/__tests__/branch.test.ts
git commit -m "feat(core): add .otto/config.json read/write"
```

---

## Task 4: `resolveBranch` — full resolution + git execution

**Files:**

- Modify: `packages/core/src/branch.ts`
- Modify: `packages/core/src/__tests__/branch.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `branch.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveBranch } from "../branch.js";

function tmpRepo2(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-rb-"));
  execFileSync("git", ["init", "-qb", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "1");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}
const base = (dir: string) => ({
  workspaceDir: dir,
  inputs: "plan-x.md",
  isTTY: false,
  now: () => "20260615-1200",
});

describe("resolveBranch", () => {
  it("defaults to current (no flag, no config, non-TTY)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("current");
    expect(r.branchName).toBeNull();
    expect(r.effectiveWorkspaceDir).toBe(dir);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("main");
  });

  it("flag wins over config", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "worktree" });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("otto/plan-x");
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("otto/plan-x");
  });

  it("config supplies the learned default", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "branch", branchPrefix: "bot/" });
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("bot/plan-x");
  });

  it("worktree mode returns a worktree dir under .otto-tmp/worktrees", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({ ...base(dir), flagStrategy: "worktree" });
    expect(r.strategy).toBe("worktree");
    expect(r.effectiveWorkspaceDir).toBe(
      join(dir, ".otto-tmp", "worktrees", "plan-x")
    );
    expect(existsSync(r.effectiveWorkspaceDir)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: r.effectiveWorkspaceDir,
      })
        .toString()
        .trim()
    ).toBe("otto/plan-x");
  });

  it("appends -2 on branch-name collision", async () => {
    const dir = tmpRepo2();
    execFileSync("git", ["branch", "otto/plan-x"], { cwd: dir });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.branchName).toBe("otto/plan-x-2");
  });

  it("falls back to a timestamp slug when inputs are empty (ghafk)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      inputs: "",
      flagStrategy: "branch",
    });
    expect(r.branchName).toBe("otto/20260615-1200");
  });

  it("errors for branch/worktree when not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-norepo-"));
    await expect(
      resolveBranch({ ...base(dir), flagStrategy: "branch" })
    ).rejects.toThrow(/not a git repo/i);
  });

  it("prompts when TTY and unresolved, and remembers on yes", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      isTTY: true,
      prompt: async () => ({ strategy: "branch" as const, remember: true }),
    });
    expect(r.strategy).toBe("branch");
    expect(readBranchConfig(dir).branchStrategy).toBe("branch");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: FAIL — `resolveBranch` not exported.

- [ ] **Step 3: Implement `resolveBranch` in `branch.ts`** (add imports + code)

```ts
import { execFileSync } from "node:child_process";
import { hasUncommittedTrackedChanges, isGitRepo, refExists } from "./git.js";

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
  /** Injectable for tests; defaults to a readline prompt. Only called when isTTY && unresolved. */
  prompt?: () => Promise<BranchPromptResult>;
  /** Injectable clock for the timestamp slug (test seam). */
  now?: () => string;
};

const DEFAULT_PREFIX = "otto/";

function timestampSlug(now: () => string): string {
  return now();
}

/** Default readline prompt. */
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

export async function resolveBranch(
  opts: ResolveBranchOptions
): Promise<ResolvedBranch> {
  const { workspaceDir, inputs, isTTY } = opts;
  const now = opts.now ?? defaultNow;
  const config = readBranchConfig(workspaceDir);
  const prefix = opts.flagPrefix ?? config.branchPrefix ?? DEFAULT_PREFIX;

  // 1. flag  2. config  3. prompt(if TTY)  4. default
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

  const slug = slugify(inputs) || timestampSlug(now);
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
    {
      cwd: workspaceDir,
      stdio: "ignore",
    }
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

/** Append -2, -3, … until the branch name is free. */
function uniqueBranchName(workspaceDir: string, name: string): string {
  if (!refExists(workspaceDir, name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!refExists(workspaceDir, candidate)) return candidate;
  }
}

function defaultNow(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
```

Note: `git` is already imported from `./git.js` in this file (added in this step's import line `import { …, git? }` — ensure `git` is in the import list: `import { git, hasUncommittedTrackedChanges, isGitRepo, refExists } from "./git.js";`).

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test && pnpm -r typecheck`
Expected: PASS (all resolveBranch cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/branch.ts packages/core/src/__tests__/branch.test.ts
git commit -m "feat(core): resolveBranch — current/branch/worktree with precedence ladder"
```

---

## Task 5: `ensureTmpIgnored` + `dirtyTreeWarning`

**Files:**

- Modify: `packages/core/src/branch.ts`
- Modify: `packages/core/src/__tests__/branch.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `branch.test.ts`:

```ts
import { ensureTmpIgnored } from "../branch.js";

describe("ensureTmpIgnored", () => {
  it("adds .otto-tmp/ to .gitignore (creating the file) and is idempotent", () => {
    const dir = tmpRepo2();
    ensureTmpIgnored(dir);
    const after = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(after).toContain(".otto-tmp/");
    ensureTmpIgnored(dir); // second call must not duplicate
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(after);
  });
  it("does not duplicate when a .otto-tmp entry already exists", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, ".gitignore"), ".otto-tmp\n");
    ensureTmpIgnored(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".otto-tmp\n");
  });
  it("only adds .otto-tmp, never .otto itself", () => {
    const dir = tmpRepo2();
    ensureTmpIgnored(dir);
    const lines = readFileSync(join(dir, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).not.toContain(".otto");
    expect(lines).not.toContain(".otto/");
  });
  it("no-ops outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-nogit-"));
    expect(() => ensureTmpIgnored(dir)).not.toThrow();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test`
Expected: FAIL — `ensureTmpIgnored` not exported.

- [ ] **Step 3: Implement in `branch.ts`** (add `appendFileSync`, `existsSync` to the `node:fs` import)

```ts
import { appendFileSync } from "node:fs"; // merge into existing node:fs import

/**
 * Ensure `.otto-tmp/` is gitignored in the workspace. No-op outside a git repo
 * or when a `.otto-tmp` entry already exists. Creates .gitignore if absent.
 * Never ignores `.otto/` (LEARNINGS.md + config.json are durable, git-tracked
 * memory).
 *
 * Idempotency is checked by scanning .gitignore text — NOT `git check-ignore`,
 * which only matches a trailing-slash dir pattern once the dir exists on disk
 * (so it would re-append every run before the first stage creates .otto-tmp/).
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
```

Also add a dirtyTreeWarning test:

```ts
import { dirtyTreeWarning } from "../branch.js";
describe("dirtyTreeWarning", () => {
  it("warns on a dirty tree for non-worktree strategies", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, "f.txt"), "changed");
    expect(dirtyTreeWarning(dir, "current")).toMatch(/uncommitted/);
    expect(dirtyTreeWarning(dir, "worktree")).toBeNull();
  });
  it("no warning on a clean tree", () => {
    expect(dirtyTreeWarning(tmpRepo2(), "current")).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- branch.test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/branch.ts packages/core/src/__tests__/branch.test.ts
git commit -m "feat(core): .gitignore hygiene + dirty-tree warning helpers"
```

---

## Task 6: CLI flags `--branch` / `--branch-prefix`

**Files:**

- Modify: `packages/core/src/cli-help.ts`
- Modify: `packages/core/src/__tests__/cli-help.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `cli-help.test.ts` (match its existing `parseFlags` test style):

```ts
it("parses --branch and --branch-prefix", () => {
  const f = parseFlags([
    "--branch",
    "worktree",
    "--branch-prefix",
    "bot/",
    "5",
  ]);
  expect(f.branch).toBe("worktree");
  expect(f.branchPrefix).toBe("bot/");
  expect(f.rest).toEqual(["5"]);
});
it("rejects an invalid --branch value", () => {
  expect(() => parseFlags(["--branch", "nope"])).toThrow(/--branch must be/);
});
it("errors when --branch has no value", () => {
  expect(() => parseFlags(["--branch"])).toThrow(/--branch requires a value/);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help.test`
Expected: FAIL — `f.branch` undefined / no throw.

- [ ] **Step 3: Implement in `cli-help.ts`**

(a) Add to `CliFlags`:

```ts
  branch?: "current" | "branch" | "worktree";
  branchPrefix?: string;
```

(b) In `parseFlags`, add locals + handlers mirroring the existing `--cooldown` pattern:

```ts
let branch: "current" | "branch" | "worktree" | undefined;
let expectingBranch = false;
let branchPrefix: string | undefined;
let expectingBranchPrefix = false;
```

In the loop, before the `if (a === "-h" …)` chain, add the consume-value branches:

```ts
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
```

In the flag-name chain add:

```ts
    else if (a === "--branch") expectingBranch = true;
    else if (a === "--branch-prefix") expectingBranchPrefix = true;
```

After the loop, add the dangling-value guards:

```ts
if (expectingBranch) {
  throw new Error("--branch requires a value");
}
if (expectingBranchPrefix) {
  throw new Error("--branch-prefix requires a value");
}
```

And add `branch, branchPrefix,` to the returned object.

(c) Add to the `Flags:` help block (after the `--review-panel` line):

```
  --branch <mode>     where Otto commits: current (default) | branch (new branch) | worktree (isolated checkout)
  --branch-prefix <p> branch name prefix for branch/worktree modes (default: otto/)
```

(d) Add to the Environment variables help block:

```
  OTTO_BRANCH          default branch strategy (current|branch|worktree) when --branch is absent.
  OTTO_BRANCH_PREFIX   default branch-name prefix (default: "otto/").
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help.test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(core): add --branch / --branch-prefix flags"
```

---

## Task 7: Wire into `run-bin.ts` + `--print-config`

**Files:**

- Modify: `packages/core/src/run-bin.ts:60` area (after `workspaceDir`), the `printConfig` call, and the dispatch block (`run-bin.ts:138-160`)
- Modify: `packages/core/src/cli-help.ts` (`PrintConfigOptions` + `printConfig` body)

- [ ] **Step 1: Resolve env + strategy in `run-bin.ts`.** After `const workspaceDir = resolve(…)` add:

```ts
const envBranch = process.env.OTTO_BRANCH?.trim();
const branchStrategyArg =
  flags.branch ??
  (envBranch === "current" || envBranch === "branch" || envBranch === "worktree"
    ? envBranch
    : undefined);
const branchPrefixArg =
  flags.branchPrefix ?? (process.env.OTTO_BRANCH_PREFIX?.trim() || undefined);
```

- [ ] **Step 2: Extend `--print-config`.** In `cli-help.ts`, add to `PrintConfigOptions`:

```ts
  branchStrategy?: "current" | "branch" | "worktree";
  branchPrefix?: string;
```

In `printConfig`, destructure them and add a line after `review`:

```ts
const branchStatus = `${branchStrategy ?? "current"} (prefix "${branchPrefix ?? "otto/"}")`;
```

```ts
  branch                ${branchStatus}
```

In `run-bin.ts`, pass them into the existing `printConfig(…, { … })` call:

```ts
      branchStrategy: branchStrategyArg,
      branchPrefix: branchPrefixArg,
```

- [ ] **Step 3: Call `resolveBranch` after the detach fork.** Add the import at the top of `run-bin.ts`:

```ts
import {
  dirtyTreeWarning,
  ensureTmpIgnored,
  resolveBranch,
} from "./branch.js";
```

Immediately **after** the `if (flags.detach && detachLogPath) { detachAndExit({…}); }` block (so the parent exits before this; only the re-spawned child / non-detach path runs it), and **before** `if (flags.watch) { … }`, add:

```ts
ensureTmpIgnored(workspaceDir);

const resolved = await resolveBranch({
  workspaceDir,
  inputs,
  isTTY: Boolean(process.stdout.isTTY),
  flagStrategy: branchStrategyArg,
  flagPrefix: branchPrefixArg,
});
process.stderr.write(`${resolved.summaryLine}\n`);
const dirtyWarn = dirtyTreeWarning(workspaceDir, resolved.strategy);
if (dirtyWarn) process.stderr.write(`⚠ ${dirtyWarn}\n`);

const effectiveWorkspaceDir = resolved.effectiveWorkspaceDir;
```

- [ ] **Step 4: Thread `effectiveWorkspaceDir` into the dispatch.** In the `runWatch({ … })` call and the `runLoop({ … })` call (further below), replace `workspaceDir,` with `workspaceDir: effectiveWorkspaceDir,`. Leave `packageDir` and everything else unchanged.

- [ ] **Step 5: Build, typecheck, run full suite.**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS.

- [ ] **Step 6: Manual smoke (real, per Henry's preference).**

```bash
# in a throwaway git repo
cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m init
OTTO_WORKSPACE=$PWD node /Users/hoangpham/source/prv/otto/apps/cli/bin/otto-afk.mjs --print-config "plan.md prd.md" 1
#   → expect a "branch   current (prefix \"otto/\")" line
OTTO_WORKSPACE=$PWD OTTO_BRANCH=worktree node /Users/hoangpham/source/prv/otto/apps/cli/bin/otto-afk.mjs --print-config "plan.md prd.md" 1
#   → expect "branch   worktree (prefix \"otto/\")"
git check-ignore .otto-tmp && echo "OK: .otto-tmp ignored"
```

(Confirm the bin path with `ls apps/cli/bin` first; `--print-config` resolves config without running the loop, so no `claude` spawn.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/run-bin.ts packages/core/src/cli-help.ts
git commit -m "feat(core): wire branch strategy into run-bin + print-config"
```

---

## Task 8: Documentation

**Files:**

- Modify: `README.md` (flags + env tables, a short "Branch strategy" note)
- Modify: `docs/ARCHITECTURE.md` (note `branch.ts`/`git.ts` and that `.otto-tmp/` is auto-ignored)

- [ ] **Step 1: README** — add `--branch`, `--branch-prefix` to the flags table; `OTTO_BRANCH`, `OTTO_BRANCH_PREFIX` to the env table; a 3-4 line note: strategy resolved once per run (flag/env → `.otto/config.json` → TTY prompt → `current`); worktree lives under `.otto-tmp/worktrees/<slug>` and is not auto-removed (`git worktree remove …` to clean up).

- [ ] **Step 2: ARCHITECTURE.md** — under the scratch-dir / support section, note `branch.ts` (startup branch resolution) and `git.ts` (shared git helpers), and that `run-bin` ensures `.otto-tmp/` is gitignored on startup.

- [ ] **Step 3: Verify + commit**

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: document branch strategy flags/env + .gitignore hygiene"
```

---

## Self-Review Notes (resolved)

- **Spec coverage:** A → Tasks 2,3,4,6,7; B (`.gitignore`) → Tasks 5,7; C (dirty warning) → Tasks 5,7; testing section → tests in Tasks 1-6; integration point (after detach fork) → Task 7 Step 3.
- **Type consistency:** `resolveBranch` returns `ResolvedBranch` everywhere; `effectiveWorkspaceDir` is the single field threaded in Task 7; `BranchStrategy` shared by `cli-help` (literal union) and `branch.ts`. `git()` signature `(args, cwd)` matches panel's existing positional calls.
- **Slug source:** afk inputs first token (plan path) → basename; ghafk inputs="" → timestamp fallback (Task 4 test covers both).
- **Detach ordering verified:** `detachAndExit` strips `--detach` and redirects child stdio to a file → child has no TTY → `resolveBranch` runs once in the child with `isTTY=false`. Placing the call after the detach block prevents a double git side-effect.
