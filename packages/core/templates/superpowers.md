# SUPERPOWERS WORKFLOW (always on)

Run this gate before the work described below. It routes every task through
brainstorm → spec → plan → TDD, adapting to how clear the input is. There is
NO human available during this run: act autonomously and record your reasoning
instead of waiting for approval.

If the `superpowers:brainstorming`, `superpowers:writing-plans`, and
`superpowers:test-driven-development` skills are available, invoke them for
fuller guidance. If they are not installed, follow the inline protocol below —
it is self-contained.

## 0. Resolve the task key and artifact paths

- GitHub issue run → task-key = `issue-<issue number>`.
- Plan/PRD run → task-key = a stable slug from the primary plan-file basename
  (e.g. `docs/plans/foo.md` → `foo`). If inputs are inline text, use a short
  kebab-case of the task title.

Per-task artifacts live together under one task directory, so everything Otto
knows about a task is in one place:

- Task dir: `.otto/tasks/<task-key>/`
- Spec path: `.otto/tasks/<task-key>/spec.md`
- Plan path: `.otto/tasks/<task-key>/plan.md`

Always **WRITE** the new task-grouped layout. The legacy flat layout
(`.otto/specs/<task-key>-design.md` + `.otto/plans/<task-key>.md`) is still
**READ** as a fallback (see the CLARITY GATE), so a task created before this
layout continues without re-brainstorming.

## 1. CLARITY GATE

Check whether the spec already exists — look under the new task dir
`.otto/tasks/<task-key>/spec.md` first, then fall back to the legacy flat path
`.otto/specs/<task-key>-design.md`.

- **Spec exists** → skip brainstorming. Read the spec and its matching plan
  (`.otto/tasks/<task-key>/plan.md`, or legacy `.otto/plans/<task-key>.md`),
  pick the next unchecked task, and go to
  TDD IMPLEMENT (section 3). If every plan task is checked AND the feedback
  loops pass, output `<promise>NO MORE TASKS</promise>`.
- **No spec** → judge the input's clarity. It is UNCLEAR if any of: no
  plan/PRD provided; a vague directive ("make it better"); missing acceptance
  criteria; multiple plausible interpretations; internal contradictions.
  - Clear enough → go straight to TDD IMPLEMENT (section 3). Optionally jot a
    short plan to `.otto/tasks/<task-key>/plan.md` first.
  - Unclear → AUTONOMOUS BRAINSTORM (section 2).

## 2. AUTONOMOUS BRAINSTORM (no human in the loop)

Play both sides of a brainstorming session:

1. List the clarifying questions a brainstorming session would ask (purpose,
   scope, constraints, success criteria, edge cases).
2. Answer each one yourself with the most reasonable default given the repo's
   existing patterns. Prefer the simplest viable option (YAGNI).
3. Write `.otto/tasks/<task-key>/spec.md` containing: Problem, Approach, an
   **Assumptions** section listing each `question → chosen answer → rationale`,
   and Testing notes.
4. Write `.otto/tasks/<task-key>/plan.md` as an ordered checklist of bite-sized,
   testable tasks (one `- [ ]` per task).
5. Do NOT wait for approval — the written assumptions are the record.

If a question is genuinely blocking (needs a secret or a human-only decision),
record the blocker in the spec and the commit body, take the safest assumption,
and make forward progress on the unblocked parts. Never stop and wait — this is
AFK.

## 3. TDD IMPLEMENT

Implement exactly one task, test-first:

1. Write a failing test that pins the intended behavior.
2. Run it; confirm it fails for the right reason.
3. Write the minimal code to make it pass.
4. Run the feedback loops described below until green.
5. Update the plan you read (`.otto/tasks/<task-key>/plan.md`, or its legacy
   fallback `.otto/plans/<task-key>.md`): check off the task. If a new durable,
   reusable learning emerged, append it to `.otto/LEARNINGS.md`.

Commit the code, the updated spec/plan, and LEARNINGS together in the single
task commit described below — do NOT make separate commits for them.
