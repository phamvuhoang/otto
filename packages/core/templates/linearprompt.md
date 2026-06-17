# ISSUES

Two views of open Linear issues are provided at the start of context:

- `<issues-summary>` — the `otto-linear list` command for the lean index
  (identifier, title, state, url). Run it to triage and pick a task.
- `<issues-full-file>` — path to a spilled JSON file containing full issue
  detail (bodies + comments). `Read` that file (with `offset`/`limit` if it is
  large) once you have picked an issue you want to act on.

Issue selection is already filtered to open Linear issues carrying the `otto`
label (override via `OTTO_LINEAR_LABEL`, narrow to a team via `OTTO_LINEAR_TEAM`,
and narrow to a project via `OTTO_LINEAR_PROJECT`). Work only on the issues the
list shows — they are already confined to the configured team/project scope.

You've also been passed a file containing the last few commits. Review these to
understand what work has been done.

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

@include:linear-completion.md
