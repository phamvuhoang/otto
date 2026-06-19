# Fixture: issue-triage (intake)

Exercises the `otto-ghafk` issue-intake loop: pick up an open labelled issue,
implement it, and finalize. This fixture is intentionally a small, real repo so
a single iteration can complete a self-contained change.

`palette.mjs` exposes a colour map; `palette.test.mjs` already pins a `teal`
colour that does not exist yet, so the suite check `tests` (`node --test`) fails
until the intake issue is implemented.

## Setup (ghafk, manual/paid)

1. `git init` this fixture dir and commit the files.
2. Create a GitHub issue labelled `otto`:

   > **Add a `teal` colour to the palette.** Add `teal: "#008080"` to
   > `palette.mjs` so the existing `palette.test.mjs` passes.

3. Point `OTTO_WORKSPACE` here and run with `otto-ghafk` (see
   `benchmarks/README.md`).
