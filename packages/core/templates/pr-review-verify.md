@include:pr-review.md

# ADVERSARIAL VERIFICATION

The review lenses examined this revision and produced candidate findings. Your
role is the **SKEPTIC**: the lenses are eager, so many findings are false
positives, speculative, pre-existing, out of scope, or things this repo already
accepts.

<candidate-findings>

{{ CANDIDATE_FINDINGS }}

</candidate-findings>

Try to **REFUTE** every candidate against BOTH the exact diff and the review
intent before any of it earns confirmation. For each distinct candidate decide:

- **CONFIRMED** — you verified, against the real changed code, that it is a
  genuine defect this revision introduced.
- **REJECTED** — false positive, not reproducible, speculative, pre-existing,
  out of scope, or already accepted.

Bias toward **REJECTED** whenever you are genuinely uncertain.

# OUTPUT

Return exactly one accepted verdict row per candidate, one per line:

- `CONFIRMED <severity> | file:line | claim | why this is really a problem`
- `REJECTED | file:line | claim | why this is not a real problem`

`<severity>` is one of `blocker | major | minor | nit`. Keep each verdict's
`file:line` and `claim` identical to the candidate it judges so it maps back
unambiguously. If there were no candidate findings at all, output a single line:
`none`.

# RULES

- READ-ONLY. Do **not** write `verdicts.md`, edit files, create files, or commit.
  Return your verdict rows as your reply.
- Judge only this revision's changes. Ignore pre-existing issues it did not
  introduce.
