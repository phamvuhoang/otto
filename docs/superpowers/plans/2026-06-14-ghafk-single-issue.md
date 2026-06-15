# otto-ghafk Single-Issue Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--issue <ref>` flag to `otto-ghafk` that points the loop at one GitHub issue and exits when that issue is done.

**Architecture:** Validate the ref to a positive integer in JS (`parseIssueRef`), carry it to a _static_ template command via the `OTTO_ISSUE` env var (security invariant: no runtime data interpolated into shell command bodies), and swap the gate stage to a dedicated `ghafk-issue.md` template when the flag is set. The existing `<promise>NO MORE TASKS</promise>` gate provides early exit, so `loop.ts` is untouched.

**Tech Stack:** TypeScript (NodeNext ESM) in `packages/core`, vitest for tests, template renderer in `render.ts`.

**Spec:** `docs/superpowers/specs/2026-06-14-ghafk-single-issue-design.md`

---

## File Structure

- `packages/core/src/cli-help.ts` — add `parseIssueRef`, `--issue` parsing, help text, printConfig row.
- `packages/core/src/__tests__/cli-help.test.ts` — **new**: tests for `parseIssueRef` + `parseFlags --issue`.
- `packages/core/src/stages.ts` — add `ghafkIssueImplementer` stage.
- `packages/core/src/gh-main.ts` — declare `issueStage`.
- `packages/core/src/run-bin.ts` — `issueStage` config, guards, env var, stage swap, inputs override.
- `packages/core/templates/ghprompt-workflow.md` — **new**: shared workflow tail extracted from `ghprompt.md`.
- `packages/core/templates/ghprompt.md` — keep list-mode head, `@include` the tail.
- `packages/core/templates/ghafk-issue.md` — **new**: single-issue gate template.
- `apps/cli/README.md` and/or `README.md` — document `--issue`.

Templates ship via the wholesale `"templates"` files glob in `packages/core/package.json` — no manifest change needed.

---

## Task 1: `parseIssueRef` helper

**Files:**

- Modify: `packages/core/src/cli-help.ts`
- Test: `packages/core/src/__tests__/cli-help.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/cli-help.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseIssueRef } from "../cli-help.js";

describe("parseIssueRef", () => {
  it("accepts a bare number", () => {
    expect(parseIssueRef("42")).toBe(42);
  });
  it("accepts the #N hash form", () => {
    expect(parseIssueRef("#42")).toBe(42);
  });
  it("accepts the owner/repo#N form", () => {
    expect(parseIssueRef("phamvuhoang/otto#42")).toBe(42);
  });
  it("accepts a GitHub issue URL", () => {
    expect(
      parseIssueRef("https://github.com/phamvuhoang/otto/issues/42")
    ).toBe(42);
  });
  it("accepts an issue URL with a comment anchor", () => {
    expect(
      parseIssueRef(
        "https://github.com/phamvuhoang/otto/issues/42#issuecomment-99"
      )
    ).toBe(42);
  });
  it("trims surrounding whitespace", () => {
    expect(parseIssueRef("  42  ")).toBe(42);
  });
  it.each(["foo", "0", "-3", "42x", "", "#", "owner/repo#", "abc#1x"])(
    "rejects %j",
    (bad) => {
      expect(() => parseIssueRef(bad)).toThrow();
    }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: FAIL — `parseIssueRef` is not exported from `../cli-help.js`.

- [ ] **Step 3: Implement `parseIssueRef`**

In `packages/core/src/cli-help.ts`, add this exported function (place it just above `parseFlags`):

```ts
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
  if (!/^\d+$/.test(token)) {
    throw new Error(
      `--issue must be a positive issue number, #N, owner/repo#N, or a GitHub issue URL, got: ${JSON.stringify(raw)}`
    );
  }
  const n = Number.parseInt(token, 10);
  if (n < 1) {
    throw new Error(
      `--issue must be a positive issue number, got: ${JSON.stringify(raw)}`
    );
  }
  return n;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: PASS (all `parseIssueRef` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(core): add parseIssueRef issue-ref validator"
```

---

## Task 2: `--issue` flag in `parseFlags`

**Files:**

- Modify: `packages/core/src/cli-help.ts:7-22` (CliFlags type) and `parseFlags`
- Test: `packages/core/src/__tests__/cli-help.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/__tests__/cli-help.test.ts`:

```ts
import { parseFlags } from "../cli-help.js";

describe("parseFlags --issue", () => {
  it("parses --issue into a number", () => {
    expect(parseFlags(["--issue", "42", "5"]).issue).toBe(42);
  });
  it("leaves issue undefined when absent", () => {
    expect(parseFlags(["5"]).issue).toBeUndefined();
  });
  it("keeps iterations as the trailing positional", () => {
    expect(parseFlags(["--issue", "42", "5"]).rest).toEqual(["5"]);
  });
  it("throws when --issue has no value", () => {
    expect(() => parseFlags(["--issue"])).toThrow("--issue requires a value");
  });
  it("throws when --issue value is invalid", () => {
    expect(() => parseFlags(["--issue", "foo", "5"])).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: FAIL — `issue` is not on the returned flags / not parsed.

- [ ] **Step 3: Add `issue` to the `CliFlags` type**

In `packages/core/src/cli-help.ts`, add to the `CliFlags` type (after `watchIntervalSec?: number;`):

```ts
  issue?: number;
```

- [ ] **Step 4: Parse `--issue` in `parseFlags`**

Add a declaration alongside the other `expecting*` locals (near line 41):

```ts
let issue: number | undefined;
let expectingIssue = false;
```

Add a consume-the-value block at the **top** of the `for` loop body, alongside the other `expecting*` blocks (e.g. after the `expectingWatchInterval` block, before the `if (a === "-h" ...)` chain):

```ts
if (expectingIssue) {
  issue = parseIssueRef(a);
  expectingIssue = false;
  continue;
}
```

Add the flag recognizer in the `else if` chain (after the `--watch-interval` line):

```ts
    else if (a === "--issue") expectingIssue = true;
```

Add the trailing missing-value guard (alongside the other post-loop guards, after the `expectingWatchInterval` guard):

```ts
if (expectingIssue) {
  throw new Error("--issue requires a value");
}
```

Add `issue` to the returned object (in the final `return { ... }`):

```ts
    issue,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(core): parse --issue flag in parseFlags"
```

---

## Task 3: `--issue` in help text and `printConfig`

**Files:**

- Modify: `packages/core/src/cli-help.ts` (`printHelp`, `PrintConfigOptions`, `printConfig`)

No new test — these are output-formatting changes verified by the manual smoke in Task 7.

- [ ] **Step 1: Add the help line**

In `printHelp`, in the `Flags:` block, add this line immediately after the `--watch-interval <sec>` line:

```
  --issue <ref>       target a single GitHub issue (number, #N, owner/repo#N, or issue URL); loop exits when it is done (ghafk-only; default: off)
```

- [ ] **Step 2: Add `issue` to `PrintConfigOptions`**

In `PrintConfigOptions`, add after `watchIntervalSec?: number;`:

```ts
  issue?: number;
```

- [ ] **Step 3: Render the issue row in `printConfig`**

In `printConfig`, destructure `issue` from `opts` (add to the existing destructure list):

```ts
    issue,
```

Just before the final `process.stdout.write(...)`, add:

```ts
const issueStatus = issue != null ? `#${issue}` : "off";
```

Add a row to the template literal, immediately after the `watch` row:

```
  issue                 ${issueStatus}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-help.ts
git commit -m "feat(core): surface --issue in help and print-config"
```

---

## Task 4: `ghafkIssueImplementer` stage + `gh-main` wiring

**Files:**

- Modify: `packages/core/src/stages.ts`
- Modify: `packages/core/src/gh-main.ts`

- [ ] **Step 1: Add the stage**

In `packages/core/src/stages.ts`, add inside the `STAGES` object (after `ghafkImplementer`):

```ts
  ghafkIssueImplementer: {
    name: "ghafk-issue-implementer",
    template: "ghafk-issue.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
```

- [ ] **Step 2: Declare the issue stage in `gh-main.ts`**

In `packages/core/src/gh-main.ts`, add to the `runBin(...)` config object (after `supportsWatch: true,`):

```ts
    issueStage: STAGES.ghafkIssueImplementer,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`
Expected: FAIL — `issueStage` is not yet a known `RunBinConfig` field. (Task 5 adds it; this confirms the wiring point.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/stages.ts packages/core/src/gh-main.ts
git commit -m "feat(core): add ghafk-issue stage and wire it in gh-main"
```

---

## Task 5: `run-bin` config, guards, env var, stage swap

**Files:**

- Modify: `packages/core/src/run-bin.ts`

- [ ] **Step 1: Add `issueStage` to `RunBinConfig`**

In `packages/core/src/run-bin.ts`, add to the `RunBinConfig` type (after `supportsWatch?: boolean;`):

```ts
  /** Alternate gate stage used when --issue is set. Only otto-ghafk sets this. */
  issueStage?: Stage;
```

- [ ] **Step 2: Add the guards + env var (single-issue mode)**

In `runBin`, immediately after the `iterations` validation block (after the `if (!Number.isFinite(iterations) || iterations < 1) { ... }` block, before the `if (flags.detach && detachLogPath)` block), add:

```ts
if (flags.issue != null) {
  if (!cfg.issueStage) {
    console.error("--issue is only supported by otto-ghafk");
    process.exit(1);
  }
  if (flags.watch) {
    console.error("--issue cannot be combined with --watch");
    process.exit(1);
  }
  // Validated positive integer (parseIssueRef) — safe for the static
  // `gh issue view "$OTTO_ISSUE"` command in ghafk-issue.md. See render.ts.
  process.env.OTTO_ISSUE = String(flags.issue);
}

const stages =
  flags.issue != null && cfg.issueStage
    ? ([cfg.issueStage, ...cfg.stages.slice(1)] as [Stage, ...Stage[]])
    : cfg.stages;
```

- [ ] **Step 3: Override `inputs` so the prompt can reference the issue**

Change the `inputs` assignment (currently `const inputs = cfg.takesInputArg ? flags.rest[0] : "";`) to:

```ts
const inputs =
  flags.issue != null
    ? String(flags.issue)
    : cfg.takesInputArg
      ? flags.rest[0]
      : "";
```

- [ ] **Step 4: Use `stages` in both run paths**

In the `runWatch({ ... })` call, change `stages: cfg.stages,` to `stages,`.
In the `runLoop({ ... })` call, change `stages: cfg.stages,` to `stages,`.

- [ ] **Step 5: Pass `issue` to `printConfig`**

In the `printConfig(...)` options object (the `if (flags.printConfig)` block), add:

```ts
      issue: flags.issue,
```

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (Task 4's wiring now resolves).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/run-bin.ts
git commit -m "feat(core): swap to issue stage and set OTTO_ISSUE when --issue is given"
```

---

## Task 6: Templates — split playbook + single-issue gate template

**Files:**

- Create: `packages/core/templates/ghprompt-workflow.md`
- Modify: `packages/core/templates/ghprompt.md`
- Create: `packages/core/templates/ghafk-issue.md`

- [ ] **Step 1: Create the shared workflow tail**

Create `packages/core/templates/ghprompt-workflow.md` with the exact content below (this is the current `ghprompt.md` from `# EXPLORATION` through `# FINAL RULES`):

````markdown
# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

### Frontend / Node

- `pnpm run test` to run the tests
- `pnpm run typecheck` to run the type checker

### Backend / Dotnet

- `dotnet test` to run the tests
- `dotnet build` to type-check

**If `dotnet test` or `dotnet build` fails with MSB3248** ("Could not resolve assembly reference" / "file is corrupt") — this is a known virtiofs/9p I/O quirk when the repo is mounted from the Windows host. It is NOT a code defect. Do not defer verification. Re-run with build outputs redirected to `/tmp` and parallelism disabled:

```bash
dotnet test <path-to-test-csproj> \
  -m:1 \
  /p:UseSharedCompilation=false \
  /p:BuildInParallel=false \
  /p:BaseIntermediateOutputPath=/tmp/otto-obj/$(basename <path-to-test-csproj> .csproj)/ \
  /p:BaseOutputPath=/tmp/otto-bin/$(basename <path-to-test-csproj> .csproj)/
```

Only if that second attempt also fails may you defer and record the blocker in the commit message.

# COMMIT

Make a single `git commit -am` with a short message:

- Subject line (≤72 chars): what changed
- Optional body (≤3 bullets): key decision, blocker for next iteration
- No file lists (git tracks them), no `Co-Authored-By`

# THE ISSUE

If the task is complete, close the original GitHub issue.

If the task is not complete, leave a comment on the GitHub issue with what was done.

# LEARNINGS

The repo's accumulated learnings are in the `<learnings>` block — durable, reusable knowledge from prior iterations (conventions, gotchas, decisions and their why, dead ends). Consult it during EXPLORATION and IMPLEMENTATION so you don't relearn what's known or repeat a dead end.

If, while doing the task, you discover a NEW durable, reusable learning — a repo convention, a non-obvious gotcha, a decision and its why, or a dead-end to avoid — append it tersely to the right section of `./.otto/LEARNINGS.md`. Create the file if it does not exist, with these four sections:

```

# Otto learnings

## Conventions

## Gotchas

## Decisions

## Dead ends

```

Dedupe against existing entries and prune anything no longer true. This file is committed WITH your task commit (it is git-tracked) — do NOT make a separate commit for it. The bar is durable AND reusable: do NOT record routine or one-off task details.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
````

- [ ] **Step 2: Trim `ghprompt.md` to its head + include**

Replace the entire content of `packages/core/templates/ghprompt.md` with:

```markdown
# ISSUES

Two views of open GitHub issues are provided at the start of context:

- `<issues-summary>` — inline lean index (number, title, labels). Use this to triage and pick a task.
- `<issues-full-file>` — path to a spilled JSON file containing bodies + comments. `Read` that file (with `offset`/`limit` if it is large) once you have picked an issue you want to act on.

You will work on the AFK issues only, not the HITL ones. Label filtering uses the `labels` field in the summary.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If all AFK tasks are complete, output <promise>NO MORE TASKS</promise>.

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Development infrastructure

Getting development infrastructure like tests and types and dev scripts ready is an important precursor to building features.

3. Tracer bullets for new features

Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

4. Polish and quick wins
5. Refactors

@include:ghprompt-workflow.md
```

- [ ] **Step 3: Verify the all-issues playbook is byte-equivalent**

The split must not change the rendered all-issues prompt. Verify by rendering both old and new (the `@include` inlines the tail with its trailing newline stripped):

Run:

```bash
node -e "import('./packages/core/dist/render.js').then(({renderTemplate})=>{const t=renderTemplate('packages/core/templates/ghprompt.md',{});process.stdout.write(t)})" > /tmp/new-ghprompt.txt
git show HEAD:packages/core/templates/ghprompt.md > /tmp/old-ghprompt.md
node -e "import('./packages/core/dist/render.js').then(({renderTemplate})=>{const t=renderTemplate('/tmp/old-ghprompt.md',{});process.stdout.write(t)})" > /tmp/old-ghprompt.txt
diff /tmp/old-ghprompt.txt /tmp/new-ghprompt.txt && echo "IDENTICAL"
```

Expected: `IDENTICAL`. (Requires `pnpm -r build` first so `dist/render.js` exists. The old template has no `@include`, so it renders as-is; the new one inlines the tail — the rendered text should match exactly.)

If they differ, it is almost certainly a trailing-newline mismatch at the split seam — adjust the blank line before `@include:ghprompt-workflow.md` until identical.

- [ ] **Step 4: Create the single-issue gate template**

Create `packages/core/templates/ghafk-issue.md`:

```markdown
<commits>

!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<issue>

!?`gh issue view "$OTTO_ISSUE" --json number,title,state|||Issue not found`

Full issue body + comments spilled to: @spill?:issue.json=`gh issue view "$OTTO_ISSUE" --json number,title,body,comments,state|||[]`

`Read` that file to get the full body and comments before acting on the issue.

</issue>

# THE TASK

Work **only** on issue #{{ INPUTS }} (shown above). Do not list, triage, or pick from any other open issues — this run is scoped to a single issue.

If issue #{{ INPUTS }} is already complete (closed, or there is no work left to do), output <promise>NO MORE TASKS</promise>.

@include:ghprompt-workflow.md
```

- [ ] **Step 5: Smoke-render the single-issue template**

Run (with `OTTO_ISSUE` set so the static `gh` commands have a value; this requires `gh` auth + a real issue, or expect the `!?`/`@spill?` fallbacks):

```bash
OTTO_ISSUE=1 node -e "import('./packages/core/dist/render.js').then(({renderTemplate})=>{const t=renderTemplate('packages/core/templates/ghafk-issue.md',{INPUTS:'1'},{spillHostDir:'/tmp/otto-spill',spillRefPath:'.otto-tmp/spill-x'});process.stdout.write(t)})"
```

Expected: prints the rendered prompt; `{{ INPUTS }}` is replaced with `1`; the `@spill` tag is replaced with a `./.otto-tmp/spill-x/issue.json` path; no `@include`/`@spill`/`!?` tags remain literally in the output. (Run `pnpm -r build` first.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/templates/ghprompt-workflow.md packages/core/templates/ghprompt.md packages/core/templates/ghafk-issue.md
git commit -m "feat(core): single-issue ghafk template + extract shared playbook"
```

---

## Task 7: Docs + full verification

**Files:**

- Modify: `README.md` (root) and/or `apps/cli/README.md` — wherever the flag table lives.

- [ ] **Step 1: Find where flags are documented**

Run: `grep -rn -- "--watch-interval" README.md apps/cli/README.md`
Use the match location to find the flag list/table.

- [ ] **Step 2: Add the `--issue` entry**

Add an entry next to `--watch`, matching the surrounding style (table row or bullet). Content:

> `--issue <ref>` — (otto-ghafk only) target a single GitHub issue instead of triaging all open ones. `<ref>` is a number, `#N`, `owner/repo#N`, or a GitHub issue URL. The loop fetches only that issue and exits when it is complete. Cannot be combined with `--watch`.

- [ ] **Step 3: Commit docs**

```bash
git add README.md apps/cli/README.md
git commit -m "docs: document otto-ghafk --issue flag"
```

- [ ] **Step 4: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all green. (`pnpm -r build` is needed so the render smoke checks and any consumers see fresh `dist/`.)

- [ ] **Step 5: Manual smoke — print-config**

Run: `node apps/cli/bin/otto-ghafk.mjs --print-config --issue 42 1` (use the actual bin path from `apps/cli/bin/`)
Expected: config output includes a row `issue                 #42`.

- [ ] **Step 6: Manual smoke — guards**

Run: `node apps/cli/bin/otto-afk.mjs --issue 42 1` (actual bin path)
Expected: exits non-zero with `--issue is only supported by otto-ghafk`.

Run: `node apps/cli/bin/otto-ghafk.mjs --issue 42 --watch 1`
Expected: exits non-zero with `--issue cannot be combined with --watch`.

Run: `node apps/cli/bin/otto-ghafk.mjs --issue foo 1`
Expected: exits non-zero, error mentions a positive issue number.

---

## Self-Review Notes

- **Spec coverage:** invocation/validation (Tasks 1–3), wiring/guards/env/stage-swap (Tasks 4–5), templates incl. `ghprompt.md` split (Task 6), edge cases (Task 5 guards + Task 7 smoke), tests (Tasks 1–2), docs (Tasks 3, 7). All spec sections map to a task.
- **Type consistency:** `parseIssueRef` returns `number`; `CliFlags.issue?: number`; `RunBinConfig.issueStage?: Stage`; `STAGES.ghafkIssueImplementer` template `ghafk-issue.md`; env var `OTTO_ISSUE` (string) read by the static `gh issue view "$OTTO_ISSUE"` command. Names consistent across tasks.
- **Security:** the only runtime value reaching a shell is the validated integer via `OTTO_ISSUE`; template command bodies stay static (render.ts invariant upheld).
- **No loop.ts change:** early exit relies on the existing `<promise>NO MORE TASKS</promise>` gate, which the single-issue template instructs the agent to emit when done.
