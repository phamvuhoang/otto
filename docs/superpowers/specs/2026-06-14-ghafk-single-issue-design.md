# otto-ghafk: target a single GitHub issue

**Status:** approved (design)
**Date:** 2026-06-14

## Problem

`otto-ghafk` always triages across _all_ open issues: `ghafk.md` hardcodes
`gh issue list --state open --limit 50` and the playbook (`ghprompt.md`) tells
the agent to pick the next task by priority. There is no way to point the loop
at one specific issue. Users want to say "work on issue #42 and stop when it's
done."

## Goal

Add an opt-in single-issue mode to `otto-ghafk`:

```bash
otto-ghafk --issue <ref> <iterations>
```

- `<ref>` accepts a bare number (`42`), hash form (`#42`), repo-qualified
  (`owner/repo#42`), or a GitHub issue URL
  (`https://github.com/owner/repo/issues/42`).
- The agent works **only** on the named issue (other open issues are never
  fetched or shown).
- The loop **exits early** when that issue is complete (the existing
  `<promise>NO MORE TASKS</promise>` gate). `<iterations>` is the safety cap.
- Absent `--issue`, behavior is **unchanged** (all-open-issues triage).

Non-goals: cross-repo targeting (a repo component in the ref is parsed but
ignored; the number is used against the workspace repo), `otto-afk` support,
`--watch` integration.

## Security boundary

`render.ts` (lines 5–10) forbids interpolating runtime/untrusted data into a
`!`/`!?`/`@spill` command body — that would be host RCE. Therefore the issue
ref must be **validated to a positive integer in JS** before it can touch a
shell. The validated integer travels via the `OTTO_ISSUE` environment
variable, which a **static** template command reads through shell expansion:

```
@spill?:issue.json=`gh issue view "$OTTO_ISSUE" --json number,title,body,comments,state|||[]`
```

The command body is a constant string; `$OTTO_ISSUE` is expanded by the shell
from an env var whose value is a validated integer. No new injection surface.
This mirrors the existing env-driven command pattern in the codebase.

## Design (Approach A — dedicated stage + template)

### 1. Invocation & validation

New optional flag `--issue <ref>`.

New exported helper in `cli-help.ts`:

```ts
export function parseIssueRef(raw: string): number;
```

Normalizes all accepted forms to a positive integer; **throws** a clear error
on anything else (non-numeric, `0`, negative, empty, malformed URL). Accepted
forms and the extracted number:

| Input                                                    | Result |
| -------------------------------------------------------- | ------ |
| `42`                                                     | `42`   |
| `#42`                                                    | `42`   |
| `owner/repo#42`                                          | `42`   |
| `https://github.com/owner/repo/issues/42`                | `42`   |
| `https://github.com/owner/repo/issues/42#issuecomment-…` | `42`   |
| `foo`, `0`, `-3`, `42x`, ``                              | throw  |

`parseFlags` gains `issue?: number`: when it sees `--issue`, it consumes the
next argv token and runs it through `parseIssueRef` (a missing value throws
`"--issue requires a value"`, matching the other value-flags).

`--help` text gains an `--issue <ref>` line. `printConfig` gains an `issue`
row (`#42` when set, `off` otherwise) and `PrintConfigOptions` gains
`issue?: number`.

### 2. Wiring

- **`stages.ts`** — add:
  ```ts
  ghafkIssueImplementer: {
    name: "ghafk-issue-implementer",
    template: "ghafk-issue.md",
    permissionMode: "bypassPermissions",
  }
  ```
- **`run-bin.ts`** — `RunBinConfig` gains `issueStage?: Stage`. After flag
  parsing, when `flags.issue != null`:
  - if `!cfg.issueStage` → `console.error("--issue is only supported by otto-ghafk")` + `exit(1)` (mirrors the `--watch`/`supportsWatch` guard).
  - if `flags.watch` → `console.error("--issue cannot be combined with --watch")` + `exit(1)`.
  - `process.env.OTTO_ISSUE = String(flags.issue)`.
  - build the stage chain with `cfg.issueStage` as `stages[0]` in place of the default gate (reviewer/rest unchanged).
  - set `inputs = String(flags.issue)` so prompt prose can reference `#{{ INPUTS }}`.
  - thread `flags.issue` into `printConfig` so `--print-config --issue 42` reflects it.
- **`gh-main.ts`** — pass `issueStage: STAGES.ghafkIssueImplementer`.
- **`loop.ts` / `render.ts` / `runner.ts`** — unchanged.

Stage swap detail: `run-bin.ts` currently passes `cfg.stages` straight through.
It will compute `const stages = flags.issue != null && cfg.issueStage ? [cfg.issueStage, ...cfg.stages.slice(1)] : cfg.stages;` and use that for both `runLoop` and the (mutually-exclusive) watch path.

### 3. Templates & playbook

- **`ghprompt.md` split** — extract its task-agnostic tail (the
  `# EXPLORATION` … `# FINAL RULES` sections) into a new
  `ghprompt-workflow.md`. `ghprompt.md` keeps its list-mode head
  (`# ISSUES`, `# TASK SELECTION`) and ends with `@include:ghprompt-workflow.md`.
  All-issues mode output is unchanged.
- **`ghafk-issue.md`** (new) — structure:
  - `<commits>` block (same `git log` as `ghafk.md`).
  - `<learnings>` block (same as `ghafk.md`).
  - `<issue>` block: lean inline summary
    `` !?`gh issue view "$OTTO_ISSUE" --json number,title,state` `` and the full
    body+comments spilled via
    `` @spill?:issue.json=`gh issue view "$OTTO_ISSUE" --json number,title,body,comments,state|||[]` ``
    with a one-line instruction to `Read` that file.
  - Preamble: "Work **only** on issue #{{ INPUTS }}. Ignore any other open
    issues. When it is complete (closed, or no work remains), output
    `<promise>NO MORE TASKS</promise>`."
  - `@include:ghprompt-workflow.md` for the shared workflow (exploration →
    feedback loops → commit → the issue close/comment step → learnings →
    final rules).

Templates ship in the tarball — `packages/core/package.json` already globs
`templates/`, so the two new files are included automatically (verify the glob
covers them).

### 4. Edge cases

| Case                     | Behavior                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `--issue` on `otto-afk` | error: not supported (no `issueStage`)                                                                                            |
| `--issue` + `--watch`    | error: cannot combine                                                                                                             |
| invalid ref              | `parseIssueRef` throws → exit 1 with the message                                                                                  |
| nonexistent issue number | `gh issue view` fails; `@spill?` fallback `[]`; agent finds nothing actionable and reports it. No extra pre-flight check (YAGNI). |

### 5. Testing

- **`parseIssueRef`** (vitest, core, `__tests__/`): every valid form →
  expected integer; every invalid form throws. This is the security-sensitive
  surface and gets the densest coverage.
- **`parseFlags`**: `--issue 42` → `issue: 42`; `--issue` with no value throws;
  `--issue foo` throws.
- Manual smoke (out of scope for CI): `otto-ghafk --print-config --issue 42`
  shows the issue row; a real `--issue <n> 1` run against a repo with that
  issue fetches only that issue.

## Files

Changed: `packages/core/src/cli-help.ts`, `run-bin.ts`, `stages.ts`,
`gh-main.ts`; `packages/core/templates/ghprompt.md` (split).
New: `packages/core/templates/ghprompt-workflow.md`,
`packages/core/templates/ghafk-issue.md`; tests under
`packages/core/src/__tests__/`.
Docs: README + `cli-help` `--help` text gain the `--issue` flag.

## Verification

`pnpm -r typecheck && pnpm -r test && pnpm test` (per CLAUDE.md). New mode is
opt-in, so existing tests should stay green; the gate is the new
`parseIssueRef`/`parseFlags` unit tests.
