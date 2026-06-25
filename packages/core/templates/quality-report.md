<!--
  The Otto quality report contract. ONE readable verification artifact, reused
  across every run mode (verify / afk / ghafk / linear-afk / apply-review) by
  @include — never re-describe the shape per template, or the provider workflows
  drift apart. Readable first; every claim cites concrete proof.
-->

Produce an **Otto quality report** with the exact section headings below. Rules:

- **Outcome-first.** Lead with what the end user can now do, drawn from the
  issue/plan intent and traceable to evidence — not marketing claims and not a
  diff summary. Keep the change description below the engineer divider.
- **Layperson-first.** Lead with plain language a non-engineer can act on — the
  prose sections (What You Can Now Do · Why · How To Verify · What To Watch ·
  What I Was Unsure About) come first; keep code-cited engineer detail below the
  divider. Write the top sections with no jargon, file paths, or SHAs.
- **Readable first.** Keep it short enough to review in a couple of minutes — a
  maintainer should not have to replay the run log. Specific beats exhaustive.
- **Verification a non-engineer can run.** _How To Verify_ is numbered,
  non-technical steps — what to do and what they should see — not a command dump.
  Include a sample command + expected result only when a layperson could run it.
- **Cite evidence for every claim.** A `file:line`, a commit SHA, a command +
  its result, a report section, or an issue/PR link — never a vague assertion.
  Evidence lives below the divider, not in the prose sections.
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

## What You Can Now Do

<Plain language, no jargon — the user-visible outcome this run enables, in one
or two sentences. Draw it from the issue/plan intent. No file paths, SHAs, or
diff summaries here; those go below the divider.>

## Why

<The goal in human terms — what problem this solves or what it now makes
possible. One or two sentences a non-engineer understands.>

## How To Verify

<Numbered, NON-technical steps a layperson can follow to confirm it works — what
to do and what they should see. A sample command + its expected result only when
a non-engineer could run it; otherwise describe what to look at.>

1. <step — and what you should see>
2. <step — and what you should see>

## What To Watch

<Risks, limits, or things to keep an eye on, in plain language — or "nothing
notable".>

## What I Was Unsure About

<What Otto was uncertain about, in human terms — the judgement calls a reviewer
should double-check — or "nothing — this was straightforward".>

---

_Engineer detail below — a non-engineer can stop reading here._

## Task Source

- Mode: <afk | ghafk | linear-afk | apply-review | verify>
- Source: <plan/PRD path, GitHub issue #, or Linear ref>
- Issue or plan: <link or path>

## What Changed

<Engineer-facing change summary: the concrete implementation or documentation
changes, one click below the user outcome. Cite evidence in the next section.>

## Evidence

- Implementation evidence: <file:line or commit SHA proving each claim; the
  commits on this branch + the files touched>
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
recurring reason ("scope creep", "thin evidence") informs _this_ run's Verdict
and _Recommended next action_ before you commit to one:

<verdict-trail>

!?`cat ./.otto/verdicts.md|||_No human verdicts recorded yet._`

</verdict-trail>

**Maintainer:** after reviewing this report, append your verdict to
`./.otto/verdicts.md` (create it lazily) — a dated `##` heading plus one line:
the human verdict (**Accepted** · **Accepted with follow-ups** · **Rejected** ·
**Needs investigation**) and _why_ (what was accepted with caveats, or the
concrete reason it was rejected). The file is git-tracked; it feeds the existing
learning loop, so future runs see what was accepted or rejected and why.

@include:acceptance-prompts.md
