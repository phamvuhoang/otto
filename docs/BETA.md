# Otto beta program

A short, structured feedback cycle: recruit a handful of maintainers to run Otto
against **their own real repos**, capture where it bites, and turn that into a
**ranked backlog** for the next quarter.

This doc is the maintainer-facing side. The participant-facing side is the
[`beta-feedback`](../.github/ISSUE_TEMPLATE/beta-feedback.md) issue template.

## Who and how

- **Recruit** 3–6 maintainers who own a repo Otto could plausibly help with —
  mix of stacks (Node, .NET, mixed) and platforms (macOS, Linux, Windows/WSL).
- **Ask each** to do one end-to-end run on a real repo: install, `claude /login`
  + `gh auth login`, pick `otto-afk` or `otto-ghafk`, and let it complete at
  least one iteration. The default `sandbox` runner is the recommended starting
  point; note if they reached for `OTTO_RUNNER=host`.
- **Capture** via the [`beta-feedback`](../.github/ISSUE_TEMPLATE/beta-feedback.md)
  template — one issue per participant (or per distinct friction), labelled
  `beta`. Filter the backlog with `is:issue label:beta`.

## What we're listening for

Each piece of feedback should land in one of the three dimensions the template
solicits:

- **Setup friction** — install, auth, config, the path to a first successful run.
- **Confusing docs** — README / CONTRIBUTING / SECURITY / `docs/*` that are
  wrong, missing, or ambiguous.
- **Unsafe defaults** — anything that did, or could, do something surprising or
  risky out of the box (sandbox scope, `bypassPermissions` blast radius, writes
  outside the workspace, credential exposure).

## Ranking rubric → ranked backlog

Score every captured item, then sort. The output of the beta cycle is a single
**ranked backlog** the team commits to for the following quarter.

Score = **severity × frequency**, with a safety override:

| Severity   | Weight | Meaning                                                    |
| ---------- | ------ | --------------------------------------------------------- |
| Blocker    | 4      | Could not complete a run / lost work / unsafe by default. |
| Major      | 3      | Real workaround needed; would deter a new adopter.        |
| Minor      | 2      | Annoying but self-recoverable.                            |
| Nit        | 1      | Cosmetic / wording.                                       |

| Frequency  | Weight | Meaning                          |
| ---------- | ------ | -------------------------------- |
| Every run  | 3      | Hit on essentially every run.    |
| Sometimes  | 2      | Hit under common conditions.     |
| Once       | 1      | One-off / edge case.             |

- **Safety override:** any **unsafe-defaults** item is treated as at least
  `Major` regardless of frequency — a rarely-hit unsafe default still ranks high.
- **Tie-break** toward items that block the [README](../README.md) quick-start or
  the documented success signals (a contributor adding a stage/template/mode from
  docs alone; a maintainer cutting/rolling back a release from the runbook).

Record the ranked list (top items first, with score and the linked `beta` issue)
in the milestone or roadmap for the next quarter. Close beta issues as they are
addressed; carry the unaddressed tail into the next cycle.
