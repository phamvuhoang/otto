<!--
  The Otto quality report contract. ONE readable verification artifact, reused
  across every run mode (verify / afk / ghafk / linear-afk / apply-review) by
  @include — never re-describe the shape per template, or the provider workflows
  drift apart. Readable first; every claim cites concrete proof.
-->

Produce an **Otto quality report** with the exact section headings below. Rules:

- **Readable first.** Keep it short enough to review in a couple of minutes — a
  maintainer should not have to replay the run log. Specific beats exhaustive.
- **Cite evidence for every claim.** A `file:line`, a commit SHA, a command +
  its result, a report section, or an issue/PR link — never a vague assertion.
- **Tests are evidence, not the verdict.** Green checks go in the Evidence
  section; they do not by themselves make the verdict Accepted.
- **Pick one honest verdict. When evidence is thin, scope is uncertain, or you
  are unsure, choose _Needs human review_ — never self-declare _Accepted_.**
  Model self-evaluation does not replace human review.

```markdown
# Otto quality report

## Verdict

One of — **Accepted** · **Accepted with follow-ups** · **Needs human review** · **Rejected**
(when uncertain, choose **Needs human review**)

## Task Source

- Mode: <afk | ghafk | linear-afk | apply-review | verify>
- Source: <plan/PRD path, GitHub issue #, or Linear ref>
- Issue or plan: <link or path>

## What Changed

- Summary: <one or two sentences — what was actually done>
- Commits: <SHAs on this branch>
- Files: <paths touched>

## Evidence

- Implementation evidence: <file:line or commit proving each claim>
- Test/typecheck evidence: <commands run + pass/fail counts>
- Manual or acceptance evidence: <what was observed, or "none">

## Human Acceptance Checklist

- [ ] Solves the stated problem.
- [ ] Behavior is observable or explained.
- [ ] Scope is appropriate.
- [ ] Docs/examples are updated when needed.
- [ ] Risks and assumptions are clear.

## Gaps And Follow-Ups

- Gap: <known gap that remains, or "none">
- Deferred: <intentionally not done in this run + why, or "none">
- Recommended next action: <what a maintainer should do next>
```

### Human verdict trail

Prior **human** verdicts on past Otto runs (most recent last) — consult them so a
recurring reason ("scope creep", "thin evidence") informs *this* run's Verdict
and *Recommended next action* before you commit to one:

<verdict-trail>

!?`cat ./.otto/verdicts.md|||_No human verdicts recorded yet._`

</verdict-trail>

**Maintainer:** after reviewing this report, append your verdict to
`./.otto/verdicts.md` (create it lazily) — a dated `##` heading plus one line:
the human verdict (**Accepted** · **Accepted with follow-ups** · **Rejected** ·
**Needs investigation**) and *why* (what was accepted with caveats, or the
concrete reason it was rejected). The file is git-tracked; it feeds the existing
learning loop, so future runs see what was accepted or rejected and why.

@include:acceptance-prompts.md
