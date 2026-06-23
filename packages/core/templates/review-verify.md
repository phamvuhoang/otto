{{ RESUME }}

<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<latest-diff>

!?`git show --stat HEAD|||No diff`

Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`

Read that file with `Read` (use `offset`/`limit` for large diffs) before judging.

</latest-diff>

# ADVERSARIAL VERIFICATION

Review lenses (correctness / security / tests) each examined HEAD and wrote findings to `{{ FINDINGS_DIR }}` — `Read` every `findings-*.md` file there.

Your role is the **SKEPTIC**. The lenses are eager: many findings will be false positives, speculative, pre-existing, out of scope, or things this repo already accepts. Try to **REFUTE** each finding against the actual HEAD diff and the surrounding code before any of them earns a fix.

For every distinct finding, decide:

- **CONFIRMED** — you verified, against the real changed code, that it is a genuine defect introduced by THIS commit.
- **REJECTED** — false positive, not reproducible, speculative, pre-existing (not introduced by HEAD), out of scope, or an already-accepted decision per `<learnings>`.

Bias toward **REJECTED** when genuinely uncertain: this loop commits fixes with no human in the loop, so a wrong or noisy fix costs more than a missed nit.

# OUTPUT

Write your verdicts to `{{ FINDINGS_DIR }}verdicts.md`, one finding per line, deduped.

Write each verdict on its own line, carrying severity (you MAY **downgrade** a
finding's severity if it is real but smaller than claimed):

- `CONFIRMED <severity> | file:line | claim | why this is really a problem`
- `REJECTED | file:line | claim | why this is not a real problem`

`<severity>` is one of `blocker | major | minor | nit`. Stay biased toward
REJECTED for anything you cannot substantiate — a false positive costs more than
a missed nit.

If the lenses produced no findings at all, write a single line: `none`.

End your reply with a one-line tally: `<verify>C confirmed, R rejected</verify>`.

# RULES

- READ-ONLY except for writing `verdicts.md`. Do **not** edit tracked files. Do **not** commit. Do **not** run feedback loops.
- Judge only HEAD's changes. Ignore pre-existing issues the commit did not introduce.
