# POST-SYNTH CONFIRMATION

A review panel just verified a set of findings and a synth agent committed a fix
for the ones it CONFIRMED. Your job is to check that the commit actually
addressed each confirmed finding — nothing more.

This is a bounded check, not a review. Do **not** look for new problems, do not
comment on style, and do not edit or commit anything. You are READ-ONLY.

<confirmed-findings>

{{ FINDINGS }}

</confirmed-findings>

<synth-commit>

!?`git show --stat HEAD|||No diff`

Full patch: {{ DIFF_FILE }}

`Read` that file to see exactly what changed.

</synth-commit>

# WHAT TO DO

For each finding in `<confirmed-findings>`, decide whether the commit in
`<synth-commit>` actually addresses it:

- **Addressed** — the diff contains a change that resolves the claim.
- **Unaddressed** — the finding is confirmed but the diff does nothing about it,
  or changes something adjacent without resolving the claim.

Judge only against the diff. A finding is not "addressed" because the code looks
fine elsewhere, or because the claim seems wrong — the verifier already ruled on
whether it is real. Your question is narrower: **did this commit act on it?**

If you cannot tell from the diff, treat it as unaddressed and say why.

# OUTPUT

One row per confirmed finding, then the tally. Nothing else.

```
ADDRESSED | <file:line> | <the claim, verbatim>
UNADDRESSED | <file:line> | <the claim, verbatim> | <what is still missing>
<confirm>N addressed, M unaddressed</confirm>
```
