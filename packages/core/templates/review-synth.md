{{ RESUME }}

<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

# REVIEW SYNTHESIS

An adversarial verifier already judged the lens findings and wrote `{{ FINDINGS_DIR }}verdicts.md`. `Read` that file. Only lines marked **`CONFIRMED`** are real defects to fix; ignore every `REJECTED` line. If the file says `none` or contains no `CONFIRMED` lines, there is nothing to fix.

# ACTION

1. Collect the `CONFIRMED` findings (already deduped and verified). If there are none, output `<review>OK</review>` and do **not** commit.
2. Otherwise apply confirmed findings **highest severity first** (blocker → major → minor).
   **Suppress nits**: if any blocker or major is confirmed, skip nit-severity
   findings entirely — do not spend a fix on them while real issues remain.

   Fix them in the working tree (only the latest commit's code — no unrelated changes), run the feedback loops:
   - Frontend / Node: `pnpm run test`, `pnpm run typecheck`
   - Backend / Dotnet: `dotnet test`, `dotnet build`

   Then make a SINGLE commit, annotating the body with what you fixed:

   ```
   fix(review): <short summary>

   Addressed:
   - blocker | file:line | <claim>
   - major   | file:line | <claim>
   Suppressed N nit(s).
   ```

   (subject ≤72 chars, no `Co-Authored-By`, no file lists). If a finding reflects a durable, reusable learning (e.g. a recurring defect class), you may also append it tersely to `./.otto/LEARNINGS.md` so it rides in this same commit.

# RULES

- Never amend the implementer's commit — always a new `fix(review):` commit.
- Trust the verifier's verdicts — do not re-litigate `REJECTED` findings or hunt for new ones.
- Single pass. Do not loop.
