<commits>

!?`git log -n 5 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<issue>

!?`gh issue view "$OTTO_ISSUE" ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --json number,title,state|||Issue not found`

Full issue body + comments spilled to: @spill?:issue.json=`gh issue view "$OTTO_ISSUE" ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --json number,title,body,comments,state|||[]`

`Read` that file to get the full body and comments before acting on the issue.

If `$OTTO_GITHUB_REPO` is set (run scoped with `--repo owner/name`), pass `--repo "$OTTO_GITHUB_REPO"` to every `gh` command you run yourself (issue comment, pr create) so completion targets that repo. If unset, `gh` uses the workspace's own repo.

@include:untrusted-content.md

</issue>

# THE TASK

Work **only** on issue #{{ INPUTS }} (shown above). Do not list, triage, or pick from any other open issues — this run is scoped to a single issue.

If issue #{{ INPUTS }} is already complete (closed, or there is no work left to do), output <promise>NO MORE TASKS</promise>.

@include:ghprompt-workflow.md
