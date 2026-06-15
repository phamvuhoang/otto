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

# RECONCILE BEFORE SELECTING

Before picking an issue, reconcile against reality: check recent `git log` and the working
tree to see whether the work for an open issue is already implemented and committed. If it
is, close/comment on the issue rather than redoing the work. Treat issue checklists as
hints, not truth — committed code is done.

@include:ghprompt-workflow.md
