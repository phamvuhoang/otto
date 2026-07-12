{{ RESUME }}

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<task>

You are implementing **one** task in an isolated worktree, as part of a parallel
fan-out (issue #66 P11). Do the whole task and nothing else.

**Task:** {{ TASK_TITLE }}

**Files you are expected to touch (your scope — do not edit files outside it):**

```
{{ TASK_SCOPE }}
```

Stay strictly within that file scope: a sibling sub-agent owns every other file
in parallel, so editing outside your scope will collide at merge time. If the
task genuinely cannot be done without touching a file outside the scope, do as
much as you safely can within scope and note the gap in your commit message.

Write the failing test first where it applies, implement, run the relevant
feedback loop, and make a single focused commit for this task. Do not push.

**Mandatory: before finishing, write `handoff.json` at the worktree root** so
the orchestrator can reconcile your work without re-deriving it. It must be a
JSON object with these keys:

```
{
  "changedFiles": ["path/one.ts", "path/two.ts"],
  "testsRun": [{ "command": "pnpm test", "passed": true }],
  "risks": ["anything the orchestrator or reviewer should double-check"],
  "deferred": ["work you knowingly left out of scope"]
}
```

`testsRun` entries are `{command, passed}` pairs for every feedback-loop
command you ran. Leave `risks`/`deferred` as empty arrays if there are none —
do not omit the file or any key.

</task>

@include:prompt.md
