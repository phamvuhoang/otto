{{ RESUME }}

<commits>

!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<issues-summary>

`otto-linear list --limit 50`

</issues-summary>

<issues-full-file>

Full issue bodies + comments spilled to: @spill?:issues.json=`otto-linear dump --limit 50|||[]`

Read that file with `Read` (use `offset`/`limit` if it is large) to get bodies and comments before picking a task. The `<issues-summary>` block above is the lean index for triage.

</issues-full-file>

@include:linearprompt.md
