# Fixture: input-sharpening (P23 / #180)

A **deterministic, no-model** eval for the roadmap's P23 success metric —
_"plan depth score increases on vague-input fixtures."_

It pins the input-sharpening signal end to end without paying for a model run:

- `vague-input.md` — a thin task that states a goal but omits constraints,
  success criteria, and non-goals. `scoreInputSharpness` should rate it low and
  flag exactly those gaps.
- `plan-baseline.md` — a plausible plan authored from the vague input **without**
  sharpening: it has a problem, a file map, and tasks, but records no
  assumptions, no scope guard, and no testable success criteria — because nothing
  prompted the author to fill the input's gaps.
- `plan-sharpened.md` — the plan authored **with** `--sharpen-input`: same work,
  plus a `## Decisions` section recording an explicit assumption for each gap the
  rubric flagged (constraints, success criteria, non-goals), a scope guard, and
  failing-test-first tasks with verify commands.

The eval (`scripts/input-sharpening-eval.test.mjs`) asserts the vague input
scores low and that `plan-sharpened.md` beats `plan-baseline.md` on both the
plan-quality and the plan-depth rubrics — i.e. addressing the flagged gaps, as
the sharpening guidance directs, measurably raises plan depth.

The paid half (replaying `otto-afk --plan --sharpen-input` against a real model
and scoring the authored plan) is intentionally **not** run in CI, matching the
rest of the benchmark suite.
