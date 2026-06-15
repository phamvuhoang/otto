# SUPERPOWERS WORKFLOW (always on)

Run this gate before the work described below. It routes every task through
brainstorm → spec → plan → TDD, adapting to how clear the input is. There is
NO human available during this run: act autonomously and record your reasoning
instead of waiting for approval.

If the `superpowers:brainstorming`, `superpowers:writing-plans`, and
`superpowers:test-driven-development` skills are available, invoke them for
fuller guidance. If they are not installed, follow the inline protocol below —
it is self-contained.

## 0. Resolve the task key

- GitHub issue run → task-key = `issue-<issue number>`.
- Plan/PRD run → task-key = a stable slug from the primary plan-file basename
  (e.g. `docs/plans/foo.md` → `foo`). If inputs are inline text, use a short
  kebab-case of the task title.

Spec path: `.otto/specs/<task-key>-design.md`
Plan path: `.otto/plans/<task-key>.md`

## 1. CLARITY GATE

Check whether `.otto/specs/<task-key>-design.md` already exists.

- **Spec exists** → skip brainstorming. Read the spec and
  `.otto/plans/<task-key>.md`, pick the next unchecked task, and go to
  TDD IMPLEMENT (section 3). If every plan task is checked AND the feedback
  loops pass, output `<promise>NO MORE TASKS</promise>`.
- **No spec** → judge the input's clarity. It is UNCLEAR if any of: no
  plan/PRD provided; a vague directive ("make it better"); missing acceptance
  criteria; multiple plausible interpretations; internal contradictions.
  - Clear enough → go straight to TDD IMPLEMENT (section 3). Optionally jot a
    short plan to `.otto/plans/<task-key>.md` first.
  - Unclear → AUTONOMOUS BRAINSTORM (section 2).

## 2. AUTONOMOUS BRAINSTORM (no human in the loop)

Play both sides of a brainstorming session:

1. List the clarifying questions a brainstorming session would ask (purpose,
   scope, constraints, success criteria, edge cases).
2. Answer each one yourself with the most reasonable default given the repo's
   existing patterns. Prefer the simplest viable option (YAGNI).
3. Write `.otto/specs/<task-key>-design.md` containing: Problem, Approach, an
   **Assumptions** section listing each `question → chosen answer → rationale`,
   and Testing notes.
4. Write `.otto/plans/<task-key>.md` as an ordered checklist of bite-sized,
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
5. Update `.otto/plans/<task-key>.md`: check off the task. If a new durable,
   reusable learning emerged, append it to `.otto/LEARNINGS.md`.

Commit the code, the updated spec/plan, and LEARNINGS together in the single
task commit described below — do NOT make separate commits for them.
