<commits>

!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<issue>

Working on Linear issue {{ INPUTS }}.

Full issue detail (body + comments) spilled to: @spill?:issue.json=`otto-linear view "$OTTO_ISSUE"|||{}`

`Read` that file to get the full body and comments before acting on the issue.

</issue>

# THE TASK

Work **only** on Linear issue {{ INPUTS }} (shown above). Do not list, triage, or pick from any other open issues — this run is scoped to a single issue.

If Linear issue {{ INPUTS }} is already complete (done, or there is no work left to do), output <promise>NO MORE TASKS</promise>.

@include:ghprompt-workflow.md
