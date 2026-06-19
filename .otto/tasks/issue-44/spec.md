# Issue #44 — P5: Skill extraction and reuse

## Problem

Otto re-plans known workflows (release flow, test bootstrap, migration patterns)
from scratch every run, re-paying planning + token cost, and the only way to make
a workflow "sticky" today is to hardcode more prompt text. There is no repo-local,
versioned, *validated* procedure store that future runs could retrieve by the
shape of the task. The outcome P5 wants: promote repeated successful trajectories
into tested, repo-local **skills** that can later be retrieved and reused.

## Approach

Land this the way every prior roadmap issue here landed (#39–#43): a **pure data
substrate first, INERT** (exported from `index.ts`, wired into no bin/loop), each
later slice adding one behavior, and the operator surface a **read-only** bin —
deliberately stopping short of auto-applying a skill in the live loop this PR
(that auto-use is a future opt-in slice; this PR makes it impossible for a skill
to regress a run). This matches exactly how #42 governed-memory shipped (substrate
+ read-only `otto-memory` bin, inert on the loop read path).

The substrate `skills.ts` mirrors `memory.ts`/`run-report.ts`: fs + JSON, absent/
malformed → safe defaults, never throws. A **skill is a directory**
`.otto/skills/<name>/` (like a run bundle, not a single JSON): `skill.json`
(metadata/constraints/capabilities/scope/validation) + an `instructions.md`
body. The **directory IS the list** (sub-dirs of `.otto/skills/`), no index.

Retrieval, validation-gating, and candidate identification are separate pure
concerns layered on top. "Require validation before use" is enforced by the
retrieval predicate filtering to validated, non-stale skills — not by the bin
executing tests (the bin stays read-only). "Inspect why a skill was selected" is
met by retrieval returning per-candidate `reasons[]`.

## Assumptions

- **Q: Auto-extract / auto-apply in the loop this PR?** A: No (user decision):
  inert substrate + read-only bin only. The loop is untouched; `skillsUsed[]`
  on the run report is an optional field populated only by a future wiring slice.
- **Q: Skill = file or directory?** A: A directory `.otto/skills/<name>/` —
  the issue lists instructions + metadata + constraints + scripts + tests + a
  last-validated run, which is a package, not a record. `name` is the
  filesystem-safe directory name; `skill.json` is the parsed metadata.
- **Q: How is "validated before use" enforced?** A: `skillStatus(skill, now)`
  derives `validated` / `unvalidated` / `stale` from the recorded
  `validation.lastValidatedRun` + a `revalidateAfterDays` freshness policy
  (mirrors `memoryStatus`). `selectSkills` returns only `validated` skills as
  *eligible*; unvalidated/stale are returned but flagged not-eligible with a
  reason. The bin never runs tests (stays read-only); recording a validation is
  the (future) job of a run, not this bin.
- **Q: Retrieval inputs?** A: `selectSkills(skills, { assessment, changedPaths,
  capability })` ranks by capability overlap, scope-glob match against
  `changedPaths`, and risk-class compatibility (using `classifyRisk`), returning
  `SkillMatch[] = { name, eligible, score, reasons[] }`. Pure, deterministic.
- **Q: Candidate identification?** A: A pure, conservative heuristic
  `findSkillCandidates(runSummaries)` — group **successful** runs by `taskKey`
  (or mode signature) and surface keys with ≥2 successes as candidates with their
  run ids. No model call, no auto-promotion — it only *suggests* what a maintainer
  might extract. Keeps the fuzzy part bounded and testable.
- **Q: Parser throws on a bad skill.json?** A: Never. Non-object/missing `name` →
  null (skipped); invalid enum/array fields → safe defaults. Same never-throw
  philosophy as every reader in this repo.

## Testing notes

- `skills.test.ts`: `allocate`/path helpers; `parseSkill` (valid round-trip,
  missing name → null, bad fields → defaults); `listSkillIds`/`readSkill`/
  `readSkills`/`writeSkill` (absent/malformed → `[]`/`null`, never throws);
  `skillStatus` freshness (validated/unvalidated/stale, unparseable ts ignored);
  `selectSkills` (capability/scope/risk match, eligibility gating, reasons,
  deterministic order); `findSkillCandidates` (≥2-success grouping, single-run
  excluded, sorted).
- `skills-cli.test.ts`: pure `formatSkillsReport`/`formatWhy` + `runSkills(argv,
  deps)` `list` / `audit` / `why` subcommands (absent dir, help, unknown).
- `run-report.test.ts` + `eval.test.ts`: optional `skillsUsed?` round-trips on
  manifest + stage; eval `skillUsageCount` aggregation (zero when absent).

## Plan slices (see plan.md)
