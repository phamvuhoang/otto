# otto-ghafk: expand `--issue` to implement sub-issues

**Status:** approved (design)
**Date:** 2026-06-19
**Issue:** [#28](https://github.com/phamvuhoang/otto/issues/28)

## Problem

`otto-ghafk --issue <n>` implements **only** the one named issue (see
`2026-06-14-ghafk-single-issue-design.md`). If that issue is a parent "epic"
whose real deliverables live in its children, those children are never fetched,
shown, or implemented. The gate template `ghafk-issue.md` fetches just the one
issue (`body` + `comments`), the prompt is hard-scoped to that issue, and the
loop exits on the first `<promise>NO MORE TASKS</promise>`. Pointing Otto at the
parent produces a vague stab at the parent prose, then quits.

Two kinds of epic exist in practice:

1. **Native** GitHub sub-issues — e.g. issue #28's example
   `LivingForever-AI/lfai-website#459` → native children #460/#461/#462.
2. **Markdown checklist** epics — e.g. this repo's
   [#38](https://github.com/phamvuhoang/otto/issues/38), whose children #39–#45
   exist only as a body task list (`- [ ] #39 — …`) with **zero** native
   sub-issues. Verified: `gh api .../issues/38/sub_issues` returns `[]`.

A native-only design silently fails on case 2 (the common in-repo shape), so
child resolution must cover both.

## Goal

Add an **opt-in** sub-issue expansion to `otto-ghafk --issue`:

```bash
otto-ghafk --issue <ref> --include-sub-issues <iterations>
OTTO_INCLUDE_SUB_ISSUES=1 otto-ghafk --issue <ref> <iterations>
```

- Resolve the target's children, then run the existing single-issue loop **once
  per open child**, each scoped exactly like today's `--issue` run (its own
  `OTTO_ISSUE`, its own sentinel, its own `state.json`).
- Absent the flag, behavior is **unchanged** (single-issue run).

### Confirmed decisions

| Question        | Decision                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| Nesting depth   | **Recursive, depth-first** (children's children expanded; cycle-guarded)       |
| Child source    | **Native `sub_issues` API first; markdown task-list fallback** when API empty  |
| Parent handling | **Skip the parent** (pure tracker — never implement parent prose)              |
| Ordering        | Native API order; markdown fallback = **body document order**; run sequentially |
| Watch mode      | **`--issue` only** — `--watch` unchanged                                        |
| Budget/cooldown | **Span the whole invocation** (cumulative across all children)                 |
| Other bins      | `otto-ghafk` only (not `otto-afk` / `otto-linear-afk`)                          |

### Why ordering is correct

#38's children are listed in the body in **P0→P6 order** (`#39 … #45`), which
matches its own declared **Dependency map** (`P0 → P1 → … → P6`, a strict
chain). Preserving **document order** (the order `- [ ] #N` items appear) and
processing each child **fully to its sentinel before the next starts** (the loop
is sequential, never parallel) satisfies that dependency order without any
special dependency parsing. Native sub-issues use the `sub_issues` API order,
which is the maintainer's arranged order — same principle.

Non-goals: dependency-graph inference beyond document order; parallel child
processing; `--watch` expansion; `otto-afk`/`otto-linear-afk`; cross-repo child
resolution (children resolve against the same repo as the parent).

## Security boundary

Same constraint as single-issue mode: runtime/untrusted data must never be
interpolated into a `!`/`!?`/`@spill` command body (host RCE — see `render.ts`).
The existing `ghafk-issue.md` template already reads only `$OTTO_ISSUE` (a
validated integer) through a **static** command, and that is unchanged.

The new helper shells out to `gh` directly from JS using **`execFileSync` with
an argv array (no shell)** — matching `watch.ts`'s `pollOpenIssues`. Issue
numbers are parsed to integers and the repo string is the already-validated
`OTTO_GITHUB_REPO` (admits only shell-safe chars via `parseGithubRepo`), so no
value is ever shell-evaluated. Markdown-parsed `#N` references are validated to
positive integers before any `gh` call.

## Design

### 1. Invocation & flags (`cli-help.ts`)

`parseFlags` gains `includeSubIssues?: boolean`, set by a **boolean** flag
`--include-sub-issues` (mirrors `--review-panel`: no value consumed).

Resolution precedence in `run-bin.ts` (mirrors other env-backed flags):

```
flags.includeSubIssues ?? truthy(process.env.OTTO_INCLUDE_SUB_ISSUES)
```

where truthy = `1`/`true`/`yes` (case-insensitive), matching existing env
parsing. `--help` gains an `--include-sub-issues` line. `printConfig` gains a
`subIssues` row (`on`/`off`) and `PrintConfigOptions` gains
`includeSubIssues?: boolean`.

**Guards** (in `run-bin.ts`, alongside the existing `--issue` guards):

- `--include-sub-issues` without `--issue` → error
  `"--include-sub-issues requires --issue"` + exit 1.
- `--include-sub-issues` on a bin without `issueStage` is unreachable (the
  `--issue` guard already fires first), but the requires-`--issue` check covers
  it regardless.

### 2. Child resolution helper (`packages/core/src/gh-sub-issues.ts`, new)

```ts
export type IssueRef = { number: number; state: "open" | "closed" };

/** Resolve the ordered list of issue numbers to process for `target`.
 *  Recursive depth-first; native sub_issues first, markdown task-list fallback;
 *  parent skipped; only OPEN issues returned. Pure orchestration over an
 *  injectable `gh` runner so it is unit-testable without network. */
export function resolveSubIssueList(
  target: number,
  opts: { repo?: string; cwd: string; gh?: GhRunner }
): number[];
```

`GhRunner` is a tiny injectable seam — `(args: string[]) => string` (stdout) —
defaulting to `execFileSync("gh", args, { cwd, encoding: "utf8", stdio: [...] })`.
Tests pass a fake.

**Algorithm** (depth-first, `visited: Set<number>` cycle guard):

1. `expand(n)`:
   a. **Native:** run
      `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate --jq '.[] | {number,state}'`.
      `--jq` streams **one JSON object per line per page**, sidestepping the
      concatenated-array problem of bare `--paginate` on array endpoints. Parse
      lines → `IssueRef[]`. If `OTTO_GITHUB_REPO` is set use `owner/repo`
      literally; else use the `{owner}`/`{repo}` placeholders (gh fills them
      from `cwd`'s repo).
   b. **Fallback:** if native returns empty, fetch the parent body
      (`gh issue view <n> --json body [--repo …]`) and parse task-list refs
      `^\s*- \[[ xX]\] #(\d+)\b` **in document order**. De-dupe within the body.
      For each ref, fetch its state
      (`gh issue view <ref> --json number,state [--repo …]`) → `IssueRef`.
   c. Returns the **direct children** of `n` as `IssueRef[]` (empty if leaf).
2. Walk depth-first from `target`: for each child in order, if `open` and not
   `visited`, mark visited, recurse `expand(child)`, then **append the child
   itself after its descendants** (leaves-first within a branch — a child's own
   sub-issues are done before the child). Closed children are skipped but still
   recursed into? **No** — a closed child means its work is done; skip its whole
   subtree.
3. **Parent is never appended** (skip-parent decision).
4. **Fallback to single-issue:** if `target` has no children at all (leaf, or
   API/markdown both empty), return `[target]` — preserves today's behavior so
   pointing at an ordinary issue still works. If it has children but all are
   closed, return `[]` (nothing to do).

Resolution never throws on a `gh` failure for an individual node: a failed
`expand` logs a warning to stderr and treats that node as a leaf (no children),
so a transient API hiccup degrades to "process what we could resolve" rather
than aborting the whole run. A total failure to resolve the target falls through
to the `[target]` single-issue fallback.

### 3. Orchestration (`run-bin.ts`)

Today `run-bin.ts` calls `runLoop` once. When sub-issue expansion is active
(`flags.issue != null && includeSubIssues`), after branch resolution:

```ts
const list = resolveSubIssueList(flags.issue, {
  repo: process.env.OTTO_GITHUB_REPO,
  cwd: effectiveWorkspaceDir,
});
process.stderr.write(`⊕ sub-issue expansion: ${list.length} issue(s) → ${list.join(", ")}\n`);

let spent = 0;
for (const n of list) {
  if (budget != null && spent >= budget) { /* stop, report */ break; }
  process.env.OTTO_ISSUE = String(n);
  const outcome = await runLoop({
    ...commonOpts,
    inputs: String(n),
    budgetUsd: budget != null ? budget - spent : undefined, // remaining budget
  });
  spent += outcome.costUsd;
}
```

- **Budget spans the invocation:** each `runLoop` receives the *remaining*
  budget; the orchestrator stops launching children once exhausted. (Each
  `runLoop` already self-stops at its own ceiling and returns `costUsd`.)
- **`iterations` is per-child** — every child gets the full safety cap, matching
  "N iterations to finish this issue".
- **State/resume is per-child:** each `runLoop` writes `state.json` keyed by its
  `inputs` (the child number). A re-run re-walks the list; an already-finished
  child hits its sentinel on the first gate stage and the loop moves on. (A
  partially-done child resumes from its saved iteration.)
- **Cooldown** is per-`runLoop` (between its own iterations), unchanged.
- The non-expansion path (`includeSubIssues` false) calls `runLoop` exactly as
  today — single call, no list, no behavioral change.

Extract the single `runLoop` call into a small local `runOne(n, budget)` helper
so the expansion loop and the single-issue path share one call site.

### 4. Files

- **New:** `packages/core/src/gh-sub-issues.ts`;
  `packages/core/src/__tests__/gh-sub-issues.test.ts`.
- **Changed:** `packages/core/src/cli-help.ts` (flag, help, print-config),
  `packages/core/src/run-bin.ts` (resolve flag, guard, orchestration loop).
- **Unchanged:** `loop.ts`, `runner.ts`, `render.ts`, `stages.ts`, `gh-main.ts`,
  templates (`ghafk-issue.md` already works per-child via `$OTTO_ISSUE`).
- **Docs:** `README.md` + `cli-help` `--help` text gain
  `--include-sub-issues` / `OTTO_INCLUDE_SUB_ISSUES`.

### 5. Edge cases

| Case                                          | Behavior                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `--include-sub-issues` without `--issue`      | error + exit 1                                                      |
| target is an ordinary leaf issue              | `[target]` → behaves exactly as single-issue mode today            |
| target has native sub-issues                  | recursive depth-first over native children, parent skipped         |
| target has markdown checklist, no native      | parse `- [ ] #N` in document order, filter open, parent skipped    |
| target has children but all closed            | `[]` → "nothing to do" line, loop runs zero children, clean exit   |
| nested sub-issues (grandchildren)             | expanded depth-first; grandchild processed before its parent child |
| cycle (A→B→A)                                 | `visited` set breaks it; each issue processed at most once         |
| `gh` fails resolving one node                 | warn to stderr, treat node as leaf; keep going                     |
| budget exhausted mid-list                     | stop launching further children; report `stopped (budget)`         |
| `--include-sub-issues` + `--watch`            | already blocked (`--issue` + `--watch` are mutually exclusive)     |

### 6. Testing

- **`resolveSubIssueList`** (vitest, core) with an injected `GhRunner` — the
  security- and logic-sensitive surface, densest coverage:
  - native children parsed from `--jq` line output; ordering preserved.
  - markdown fallback parses `- [ ] #N` / `- [x] #N` in document order; ignores
    non-task-list `#N` mentions; de-dupes.
  - recursion depth-first (grandchild before child); parent never in output.
  - closed children + closed subtrees skipped; all-closed → `[]`.
  - leaf / both-empty → `[target]`.
  - cycle guard terminates.
  - a throwing `gh` for one node degrades to leaf, doesn't abort.
- **`parseFlags`**: `--include-sub-issues` → `includeSubIssues: true`; absent →
  `undefined`.
- **`run-bin` guard**: `--include-sub-issues` without `--issue` exits 1 (cover
  via the existing run-bin guard test style if present, else a focused unit).
- Manual smoke (out of CI): `otto-ghafk --print-config --issue 38
  --include-sub-issues` shows the row; a real
  `otto-ghafk --issue 38 --include-sub-issues 1` resolves `[39,40,…,45]`.

## Verification

`pnpm -r typecheck && pnpm -r test && pnpm test` (per CLAUDE.md). The feature is
opt-in, so existing tests stay green; the new gate is the `gh-sub-issues`
unit suite plus the `parseFlags`/guard tests.
