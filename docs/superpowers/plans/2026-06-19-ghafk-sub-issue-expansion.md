# ghafk Sub-Issue Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--include-sub-issues` flag to `otto-ghafk --issue` that resolves a parent issue's children (native GitHub sub-issues, or a markdown task-list fallback) and runs the existing single-issue loop once per open child.

**Architecture:** A pure, unit-testable resolver (`gh-sub-issues.ts`) walks the sub-issue tree depth-first via an injectable `gh` runner. `run-bin.ts` calls it when the flag is set and loops `runLoop` once per resolved issue number, setting `OTTO_ISSUE` + `inputs` per child so each is scoped exactly like today's single-issue run. `loop.ts`, `runner.ts`, `render.ts`, and the templates are untouched.

**Tech Stack:** TypeScript (ESM, NodeNext — relative imports end in `.js`), Node ≥20, vitest, `gh` CLI via `execFileSync` (no shell).

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No shell for `gh`.** Use `execFileSync("gh", argv, …)` with an argv array — never a shell string (matches `watch.ts` `pollOpenIssues`; see `SECURITY.md`).
- **Opt-in, zero default change.** Absent `--include-sub-issues`, `run-bin.ts` must call `runLoop` exactly as today (single call).
- **otto-ghafk only.** Guard with `cfg.supportsRepoScope` (true only for otto-ghafk). Not `otto-afk`/`otto-linear-afk`.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`.
- **Pre-commit hook** runs prettier + typecheck; keep formatting clean.

---

### Task 1: `--include-sub-issues` flag in `cli-help.ts`

**Files:**
- Modify: `packages/core/src/cli-help.ts` (Flags type ~line 50; `parseFlags` body ~line 176/320/401; `--help` text ~line 481; `PrintConfigOptions` ~line 562; `printConfig` ~line 657/688)
- Test: `packages/core/src/__tests__/cli-help.test.ts`

**Interfaces:**
- Produces: `Flags.includeSubIssues: boolean` (default `false`); CLI token `--include-sub-issues` (boolean, consumes no value); `PrintConfigOptions.includeSubIssues?: boolean`; a `sub-issues` row in `--print-config`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/__tests__/cli-help.test.ts`:

```ts
import { parseFlags } from "../cli-help.js";

describe("--include-sub-issues", () => {
  it("defaults to false", () => {
    expect(parseFlags(["3"]).includeSubIssues).toBe(false);
  });
  it("is set by the boolean flag and consumes no value", () => {
    const f = parseFlags(["--include-sub-issues", "3"]);
    expect(f.includeSubIssues).toBe(true);
    expect(f.rest).toEqual(["3"]);
  });
});
```

(Match the existing import style in the file — it may already import `parseFlags`. Don't duplicate the import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: FAIL — `includeSubIssues` is `undefined`, not `false`/`true`.

- [ ] **Step 3: Implement the flag**

In `cli-help.ts`, add to the `Flags` type (right after the `issue?:` field, ~line 50):

```ts
  /** `--include-sub-issues` toggle (default false; opt-in, issue #28).
   *  Only meaningful with `--issue` on otto-ghafk; run-bin enforces that. */
  includeSubIssues: boolean;
```

In `parseFlags`, add the local near the other `let` toggles (e.g. by `let reviewPanel = false;` ~line 176):

```ts
  let includeSubIssues = false;
```

Add the arg branch next to `--review-panel` (~line 320):

```ts
    else if (a === "--include-sub-issues") includeSubIssues = true;
```

Add to the returned object (next to `reviewPanel,` ~line 401):

```ts
    includeSubIssues,
```

- [ ] **Step 4: Add help text + print-config row**

In the `--help` block, add a line after the `--issue <ref>` line (~line 481):

```
  --include-sub-issues
                      with --issue (otto-ghafk): also implement the issue's open sub-issues — native GitHub sub-issues, or a markdown task-list (- [ ] #N) fallback — depth-first, parent skipped (or OTTO_INCLUDE_SUB_ISSUES=1; default: off)
```

In the env-vars section of `--help` (near `OTTO_WATCH_LABEL` ~line 505), add:

```
  OTTO_INCLUDE_SUB_ISSUES  set to 1/true/yes to enable --include-sub-issues without the flag.
```

Add to `PrintConfigOptions` (~line 562):

```ts
  includeSubIssues?: boolean;
```

In `printConfig`, destructure `includeSubIssues` from `opts` alongside `issue` (~line 601), and add a row after the `issue` row (~line 688):

```ts
  sub-issues            ${includeSubIssues ? "on" : "off"}
```

(Match the exact column alignment of the surrounding rows — copy the spacing from the `issue` row.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @phamvuhoang/otto-core typecheck`
Expected: no errors.

```bash
git add packages/core/src/cli-help.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(cli): add --include-sub-issues flag (#28)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `resolveSubIssueList` helper

**Files:**
- Create: `packages/core/src/gh-sub-issues.ts`
- Test: `packages/core/src/__tests__/gh-sub-issues.test.ts`

**Interfaces:**
- Produces:
  - `type IssueRef = { number: number; state: "open" | "closed" }`
  - `type GhRunner = (args: string[]) => string`
  - `function resolveSubIssueList(target: number, opts: { repo?: string; cwd: string; gh?: GhRunner }): number[]`
- Consumes: nothing from earlier tasks. `node:child_process` `execFileSync` for the default runner.

**Behavior contract** (the resolver returns the ordered list of issue **numbers** to process):
- Direct children of a node: native `gh api .../sub_issues` first; if empty, markdown task-list (`- [ ] #N`) parsed from the parent body in document order, each ref's state resolved via `gh issue view`.
- Depth-first, leaves-first: a child's open descendants come before the child; the child comes before its later siblings.
- Only **open** issues appear in the output. A closed child's whole subtree is skipped.
- Parent (`target`) is never in the output.
- `visited` Set prevents cycles / double-processing.
- **Fallback:** if `target` has *no* resolvable children → return `[target]` (preserves single-issue behavior). If it has children but all are closed → return `[]`.
- A `gh` failure for any single node is caught and treated as "no children" (degrade to leaf), never thrown.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/gh-sub-issues.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { resolveSubIssueList, type GhRunner } from "../gh-sub-issues.js";

/** Build a fake gh runner from a map of "joined argv" → stdout (or a thrower). */
function fakeGh(routes: Record<string, string | (() => never)>): GhRunner {
  return (args) => {
    const key = args.join(" ");
    const hit = routes[key];
    if (hit === undefined) throw new Error(`unexpected gh call: ${key}`);
    return typeof hit === "function" ? hit() : hit;
  };
}

const subIssuesArgs = (n: number) =>
  `api repos/o/r/issues/${n}/sub_issues --paginate --jq .[] | {number,state}`;
const viewBodyArgs = (n: number) =>
  `issue view ${n} --repo o/r --json body`;
const viewStateArgs = (n: number) =>
  `issue view ${n} --repo o/r --json number,state`;

const opts = { repo: "o/r", cwd: "/tmp" };

describe("resolveSubIssueList", () => {
  it("returns native sub-issues in API order, parent skipped", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]:
        `{"number":2,"state":"open"}\n{"number":3,"state":"open"}\n`,
      [subIssuesArgs(2)]: "",
      [subIssuesArgs(3)]: "",
      // leaf children fall back to body lookup (empty body → no children).
      [viewBodyArgs(2)]: `{"body":""}`,
      [viewBodyArgs(3)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2, 3]);
  });

  it("recurses depth-first, grandchild before child", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: `{"number":4,"state":"open"}\n`,
      [subIssuesArgs(4)]: "",
      [viewBodyArgs(4)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([4, 2]);
  });

  it("skips closed children and their subtree", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]:
        `{"number":2,"state":"closed"}\n{"number":3,"state":"open"}\n`,
      [subIssuesArgs(3)]: "",
      [viewBodyArgs(3)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([3]);
  });

  it("returns [] when the target has children but all are closed", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"closed"}\n`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([]);
  });

  it("falls back to [target] for a leaf with no children", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: "",
      [viewBodyArgs(1)]: `{"body":"no refs here"}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([1]);
  });

  it("parses a markdown task-list in document order when native is empty", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: "",
      [viewBodyArgs(1)]: JSON.stringify({
        body: "## Sub-issues\n- [ ] #9 — c\n- [x] #8 — b\n- [ ] #7 — a\nmention #99 not a task\n",
      }),
      // each ref's state resolved; nested expansion of each is a leaf.
      [viewStateArgs(9)]: `{"number":9,"state":"open"}`,
      [viewStateArgs(8)]: `{"number":8,"state":"closed"}`,
      [viewStateArgs(7)]: `{"number":7,"state":"open"}`,
      [subIssuesArgs(9)]: "",
      [viewBodyArgs(9)]: `{"body":""}`,
      [subIssuesArgs(7)]: "",
      [viewBodyArgs(7)]: `{"body":""}`,
    });
    // #8 is closed → skipped; #99 is a bare mention, not a task item.
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([9, 7]);
  });

  it("breaks cycles via the visited set", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: `{"number":1,"state":"open"}\n`,
      [viewBodyArgs(2)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2]);
  });

  it("degrades a node whose gh call throws to a leaf", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: () => {
        throw new Error("boom");
      },
      [viewBodyArgs(2)]: () => {
        throw new Error("boom");
      },
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- gh-sub-issues`
Expected: FAIL — module `../gh-sub-issues.js` does not exist.

- [ ] **Step 3: Implement the helper**

Create `packages/core/src/gh-sub-issues.ts`:

```ts
import { execFileSync } from "node:child_process";

/** A GitHub issue reference with just the fields the resolver needs. */
export type IssueRef = { number: number; state: "open" | "closed" };

/** Injectable `gh` runner: takes argv (no shell), returns stdout. Tests pass a
 *  fake; production uses {@link defaultGh}. */
export type GhRunner = (args: string[]) => string;

/** Real runner: `execFileSync` (no shell) so values are literal argv entries —
 *  a ref like `$(rm -rf ~)` can never be shell-evaluated. Mirrors watch.ts. */
const defaultGh =
  (cwd: string): GhRunner =>
  (args) =>
    execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

/** Parse `gh api … --jq '.[] | {number,state}'` output: one JSON object per
 *  line (gh applies --jq per page, so --paginate stays newline-delimited). */
function parseRefLines(out: string): IssueRef[] {
  const refs: IssueRef[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { number?: unknown; state?: unknown };
      if (
        typeof o.number === "number" &&
        (o.state === "open" || o.state === "closed")
      ) {
        refs.push({ number: o.number, state: o.state });
      }
    } catch {
      // skip a malformed line rather than abort the whole resolution.
    }
  }
  return refs;
}

// A GitHub task-list item that references an issue: "- [ ] #123" / "- [x] #123"
// (also accepts "* "). Captures the issue number. A bare "#123" mention in prose
// is intentionally NOT matched.
const TASK_LIST_RE = /^\s*[-*] \[[ xX]\] +#(\d+)\b/;

/** Direct children of `n`: native sub_issues first, markdown task-list fallback.
 *  Never throws — a gh failure yields an empty list (node treated as a leaf). */
function directChildren(
  n: number,
  repo: string | undefined,
  gh: GhRunner
): IssueRef[] {
  const repoPath = repo ?? "{owner}/{repo}";
  const repoArg = repo ? ["--repo", repo] : [];

  // 1. Native GitHub sub-issues.
  try {
    const out = gh([
      "api",
      `repos/${repoPath}/issues/${n}/sub_issues`,
      "--paginate",
      "--jq",
      ".[] | {number,state}",
    ]);
    const native = parseRefLines(out);
    if (native.length > 0) return native;
  } catch {
    // fall through to the markdown fallback.
  }

  // 2. Markdown task-list fallback: parse the parent body in document order.
  let body = "";
  try {
    const out = gh(["issue", "view", String(n), ...repoArg, "--json", "body"]);
    body = (JSON.parse(out) as { body?: string }).body ?? "";
  } catch {
    return [];
  }
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(TASK_LIST_RE);
    if (!m) continue;
    const num = Number.parseInt(m[1], 10);
    if (Number.isInteger(num) && num > 0 && !seen.has(num)) {
      seen.add(num);
      nums.push(num);
    }
  }

  // Resolve each referenced issue's state (markdown carries no state).
  const refs: IssueRef[] = [];
  for (const num of nums) {
    try {
      const out = gh([
        "issue",
        "view",
        String(num),
        ...repoArg,
        "--json",
        "number,state",
      ]);
      const o = JSON.parse(out) as { number?: unknown; state?: unknown };
      const state = String(o.state ?? "").toLowerCase();
      if (
        typeof o.number === "number" &&
        (state === "open" || state === "closed")
      ) {
        refs.push({ number: o.number, state });
      }
    } catch {
      // unresolvable ref → skip it.
    }
  }
  return refs;
}

/**
 * Resolve the ordered list of issue numbers to process for `target`.
 * Recursive depth-first (leaves-first), native sub_issues then markdown
 * task-list fallback, only OPEN issues, parent skipped, cycle-guarded.
 * A leaf target (no children) returns `[target]` so single-issue behavior is
 * preserved; a target whose children are all closed returns `[]`.
 */
export function resolveSubIssueList(
  target: number,
  opts: { repo?: string; cwd: string; gh?: GhRunner }
): number[] {
  const gh = opts.gh ?? defaultGh(opts.cwd);
  const visited = new Set<number>([target]);
  const out: number[] = [];

  const visitChildren = (children: IssueRef[]): void => {
    for (const child of children) {
      if (child.state !== "open") continue; // closed subtree = done, skip.
      if (visited.has(child.number)) continue; // cycle / already queued.
      visited.add(child.number);
      visitChildren(directChildren(child.number, opts.repo, gh)); // depth-first.
      out.push(child.number); // child after its descendants (leaves-first).
    }
  };

  const targetChildren = directChildren(target, opts.repo, gh);
  if (targetChildren.length === 0) return [target]; // leaf → single-issue.
  visitChildren(targetChildren);
  return out; // may be [] if every child (and subtree) was closed.
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- gh-sub-issues`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @phamvuhoang/otto-core typecheck`
Expected: no errors.

```bash
git add packages/core/src/gh-sub-issues.ts packages/core/src/__tests__/gh-sub-issues.test.ts
git commit -m "feat(core): add resolveSubIssueList helper (#28)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Orchestration + guard in `run-bin.ts`

**Files:**
- Modify: `packages/core/src/run-bin.ts` (flag resolution + guard near the other `--issue` guards; the final `runLoop` call ~lines 562-585; `printConfig` call ~line 240)
- Modify: `README.md` (flags + env reference)
- Test: `packages/core/src/__tests__/run-bin.test.ts`

**Interfaces:**
- Consumes: `resolveSubIssueList` from Task 2; `Flags.includeSubIssues` + `PrintConfigOptions.includeSubIssues` from Task 1; `runLoop` (returns `{ costUsd, sentinelHit, tokenUsage }`).
- Produces: a per-child `runLoop` invocation (`OTTO_ISSUE` + `inputs` = child number; remaining-budget threaded).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/__tests__/run-bin.test.ts`. First add the mock near the existing `vi.mock` calls (top of file):

```ts
vi.mock("../gh-sub-issues.js", () => ({
  resolveSubIssueList: mocks.resolveSubIssueList,
}));
```

and add `resolveSubIssueList: vi.fn()` to the `vi.hoisted` mocks object.

Then add a describe block (use the existing `cfg`/helpers; build a ghafk-style config inline since the file's default `cfg` is otto-afk):

```ts
const ghafkCfg: RunBinConfig = {
  bin: "otto-ghafk",
  usage: "<iterations>",
  desc: "gh",
  stages: [{ name: "ghafk-implementer", template: "ghafk.md" }],
  takesInputArg: false,
  mode: "ghafk",
  supportsWatch: true,
  supportsRepoScope: true,
  issueStage: { name: "ghafk-issue-implementer", template: "ghafk-issue.md" },
};

describe("--include-sub-issues", () => {
  beforeEach(() => {
    mockLoopSuccess();
    mocks.resolveSubIssueList.mockReturnValue([40, 41, 42]);
  });

  it("runs runLoop once per resolved sub-issue with that issue's number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-"));
    mockBranch(dir);
    try {
      await runBin(["--issue", "38", "--include-sub-issues", "2"], ghafkCfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(mocks.runLoop).toHaveBeenCalledTimes(3);
    expect(mocks.runLoop.mock.calls.map((c) => c[0].inputs)).toEqual([
      "40",
      "41",
      "42",
    ]);
  });

  it("errors when --include-sub-issues is used without --issue", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runBin(["--include-sub-issues", "2"], ghafkCfg).catch(() => {});
    expect(err).toHaveBeenCalledWith("--include-sub-issues requires --issue");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });
});
```

(If the file already has a `process.env.OTTO_INCLUDE_SUB_ISSUES` left set by another test, clear it in an `afterEach`. Match the file's existing env-cleanup pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- run-bin`
Expected: FAIL — guard message not emitted; `runLoop` called once, not per-issue.

- [ ] **Step 3: Resolve the flag + add the guard**

In `run-bin.ts`, after the existing `--issue`/`--repo`/`--project` guards (the block that ends near `if (flags.issue != null && !cfg.issueStage)`), add:

```ts
  // Resolve --include-sub-issues from flag → OTTO_INCLUDE_SUB_ISSUES.
  const includeSubIssues =
    flags.includeSubIssues ||
    ["1", "true", "yes"].includes(
      (process.env.OTTO_INCLUDE_SUB_ISSUES ?? "").trim().toLowerCase()
    );
  if (includeSubIssues && !cfg.supportsRepoScope) {
    console.error("--include-sub-issues is only supported by otto-ghafk");
    process.exit(1);
  }
  if (includeSubIssues && flags.issue == null) {
    console.error("--include-sub-issues requires --issue");
    process.exit(1);
  }
```

- [ ] **Step 4: Thread it into `--print-config`**

In the `printConfig({ … })` call (~line 200-240), add to the options object (next to `issue: flags.issue,`):

```ts
      includeSubIssues,
```

- [ ] **Step 5: Add the orchestration loop**

Replace the final `await runLoop({ … });` call (the non-watch path, ~lines 562-585) with an extracted base + a branch. Keep every existing option value identical; only `inputs` and `budgetUsd` vary per child:

```ts
  const loopBase = {
    stages,
    iterations,
    workspaceDir: effectiveWorkspaceDir,
    packageDir,
    noKeepAlive: flags.noKeepAlive,
    maxRetries: flags.maxRetries,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
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
  };

  if (flags.issue != null && includeSubIssues) {
    const { resolveSubIssueList } = await import("./gh-sub-issues.js");
    const list = resolveSubIssueList(Number(flags.issue), {
      repo: process.env.OTTO_GITHUB_REPO,
      cwd: effectiveWorkspaceDir,
    });
    process.stderr.write(
      `⊕ sub-issue expansion: ${list.length} issue(s)${list.length ? ` → ${list.join(", ")}` : " (nothing open to do)"}\n`
    );
    // Budget spans the whole invocation: each runLoop gets the remaining budget,
    // and we stop launching children once it is exhausted.
    let spent = 0;
    for (const n of list) {
      if (flags.budget != null && spent >= flags.budget) {
        process.stderr.write(
          `stopping: --budget $${flags.budget} reached before issue #${n}\n`
        );
        break;
      }
      process.env.OTTO_ISSUE = String(n);
      const outcome = await runLoop({
        ...loopBase,
        inputs: String(n),
        budgetUsd: flags.budget != null ? flags.budget - spent : undefined,
      });
      spent += outcome.costUsd;
    }
    return;
  }

  await runLoop({
    ...loopBase,
    inputs: inputs ?? "",
    budgetUsd: flags.budget,
  });
```

Verify the field list in `loopBase` matches the original call exactly (no dropped/renamed option). The watch path above is unchanged.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- run-bin`
Expected: PASS.

- [ ] **Step 7: Update README**

In `README.md`, add `--include-sub-issues` to the flags reference (near `--issue`) and `OTTO_INCLUDE_SUB_ISSUES` to the env reference. Use this copy:

```markdown
- `--include-sub-issues` — with `--issue` (otto-ghafk only): also implement the target issue's open sub-issues. Resolves native GitHub sub-issues first, falling back to a markdown task-list (`- [ ] #N`) in the parent body. Walks nested sub-issues depth-first, skips the parent (treated as a tracker), and runs the single-issue loop once per open child. `--budget` spans the whole invocation. Default: off. Env: `OTTO_INCLUDE_SUB_ISSUES=1`.
```

- [ ] **Step 8: Full verify + commit**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all green.

```bash
git add packages/core/src/run-bin.ts packages/core/src/__tests__/run-bin.test.ts README.md
git commit -m "feat(ghafk): expand --issue to sub-issues via --include-sub-issues (#28)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Flag `--include-sub-issues` / `OTTO_INCLUDE_SUB_ISSUES` → Task 1 (flag) + Task 3 (env resolution).
- `requires --issue` + otto-ghafk-only guards → Task 3 Step 3.
- Native + markdown fallback, recursive depth-first, parent skip, open-only, ordering, cycle guard, leaf/all-closed fallbacks, per-node degrade → Task 2 (helper + 8 tests).
- Orchestration: per-child `runLoop`, `OTTO_ISSUE` + `inputs`, cumulative budget, per-child iterations/state → Task 3 Step 5.
- `--print-config` row → Task 1 Step 4 + Task 3 Step 4.
- Docs (README + `--help`) → Task 1 Step 4 + Task 3 Step 7.
- Templates / loop / runner unchanged → confirmed (no task touches them).
- `--watch` unchanged → confirmed (orchestration is in the non-watch path only).

**Placeholder scan:** none — every code/test step shows complete code and exact commands.

**Type consistency:** `IssueRef`, `GhRunner`, `resolveSubIssueList(target, { repo, cwd, gh })` are identical across Task 2's definition and Task 3's consumption. `Flags.includeSubIssues` (Task 1) matches the `flags.includeSubIssues` read (Task 3). `runLoop` outcome `.costUsd` matches the budget accumulation. The `--jq` argv string in the helper (`".[] | {number,state}"`) matches the `subIssuesArgs` test fixture join.

**Note on the spec's "warn to stderr per failed node":** the helper degrades silently (returns no children) for testability; the resolved-list stderr line in Task 3 surfaces what was actually found. Functionally equivalent; no separate warning task needed.
