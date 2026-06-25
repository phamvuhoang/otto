{{ RESUME }}

<commits>

!?`git log -n 15 --format="%H%n%ad%n%s---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<inputs>

{{ INPUTS }}

</inputs>

# PLAN (AUTHOR THE SPEC + PLAN — DO NOT IMPLEMENT)

You are PLANNING, not implementing. Turn the thin task in `<inputs>` into a
world-class, structured **spec** and a task-decomposed **plan**, persisted for
human review _before_ any code is written. There is NO human available during
this run: act autonomously and **record your reasoning** instead of waiting for
approval ("record assumptions and proceed").

**Make NO source edits and NO implementation.** The only files you may write are
the spec and plan named below (plus checking off nothing yet). Do not touch
`packages/`, `apps/`, `src/`, or any product code.

## 0. Resolve the task key and artifact paths

- GitHub issue run → task-key = `issue-<issue number>`.
- Plan/PRD run → task-key = a stable slug from the primary plan-file basename
  (e.g. `docs/plans/foo.md` → `foo`); inline text → a short kebab-case of the
  task title.

Per-task artifacts live together so everything Otto knows about a task is in one
place:

- Task dir: `.otto/tasks/<task-key>/`
- Spec path: `.otto/tasks/<task-key>/spec.md`
- Plan path: `.otto/tasks/<task-key>/plan.md`

## 1. ALREADY PLANNED?

If `.otto/tasks/<task-key>/spec.md` AND `.otto/tasks/<task-key>/plan.md` already
exist and the plan covers the task, there is nothing to author — output
`<promise>NO MORE TASKS</promise>` and stop. Otherwise continue.

## 2. AUTONOMOUS BRAINSTORM

Play both sides of a brainstorming session: list the clarifying questions a
brainstorm would ask (purpose, scope, constraints, success criteria, edge
cases), then answer each yourself with the most reasonable default given the
repo's existing patterns. Prefer the simplest viable option (YAGNI). `Read` the
relevant existing code first so the file map and decisions are grounded, not
guessed.

## 3. WRITE THE SPEC — `.otto/tasks/<task-key>/spec.md`

Use the `Write` tool. The spec MUST contain these sections (this is the shape the
plan-quality rubric scores — a world-class plan has all of them):

- `## Problem` — who is blocked, what they cannot do, and why it matters.
- `## Decisions` (or `## Assumptions`) — each `question → chosen answer →
rationale`; record blockers and the safest assumption taken.
- `## Scope guard` — what is explicitly **out of scope** / the **non-goals**, so
  the implementer does not sprawl.
- `## File map` — the component/file map: the specific files this work will
  create or modify, as backticked paths (e.g. `packages/core/src/foo.ts`).
- `## Testing notes` — how it will be verified, and the **testable success
  criteria** (done-when conditions).

## 4. WRITE THE PLAN — `.otto/tasks/<task-key>/plan.md`

Use the `Write` tool. An ordered checklist of **bite-sized, testable tasks**, one
`- [ ]` per task (sized so each is one Otto run). Every task MUST state:

- a **failing-test-first** step (write the test that pins the behavior, watch it
  fail, then implement), and
- an explicit **verify** command (e.g. `verify: \`pnpm -r typecheck && pnpm -r
  test\``) — the exact command that proves the task is done.

Keep tasks ordered so each is gated on the prior; name the test file that pins
each task.

## 4b. WRITE THE TASK GRAPH (optional) — `.otto/tasks/<task-key>/tasks.json`

Use the `Write` tool to also emit a machine-readable task graph so Otto can fan
independent tasks out to isolated sub-agents (issue #66 P11). Shape:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "t1",
      "title": "<short>",
      "fileScope": ["path/you/expect/to/touch"],
      "dependsOn": [],
      "parallelSafe": true
    },
    {
      "id": "t2",
      "title": "<short>",
      "fileScope": ["other/path"],
      "dependsOn": ["t1"],
      "parallelSafe": false
    }
  ]
}
```

Rules: `id` unique; `dependsOn` lists earlier task ids that must land first;
`fileScope` lists the files the task is expected to edit; set `parallelSafe`
**true only when** the task shares no files and no ordering with its siblings —
**be conservative and default to `false` when unsure**. This file is OPTIONAL:
if the work does not decompose into cleanly independent tasks, omit it and the
run proceeds sequentially. A malformed file is ignored (fan-out simply disabled).

## 4c. SELF-CHECK PLAN DEPTH ONCE

Before committing, inspect the spec + plan you wrote. If any item below is
missing, revise the artifacts once before you commit:

- File map names at least two real repo paths in backticks.
- Every task names the failing test file/case it will start with and includes an
  explicit `verify:` command.
- Success criteria are concretely testable: a reviewer can tell pass/fail from
  an observable result, test, or command.

## 5. COMMIT

Commit ONLY the spec + plan + (if written) the task graph — this is the whole
run, no code. Use a `docs(plan):` or `chore(plan):` commit. Then print a one-line
summary of the task-key and the number of plan tasks authored. Do not implement;
the human reviews the plan next.

## 6. QUALITY REPORT

Before you output `<promise>NO MORE TASKS</promise>`, emit one Otto quality
report for this plan-authoring run. Frame it around what the maintainer can now
do with the authored plan (approve it, edit it, or reject it before
implementation), not around the diff.

@include:quality-report.md
