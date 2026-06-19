# Issue #44 plan — Skill extraction and reuse

Each slice is one commit. Substrate slices are INERT (exported from `index.ts`,
wired into no bin/loop) so they cannot regress a live run. The operator surface
is a **read-only** bin. Auto-apply in the loop is deliberately out of scope for
this PR (a future opt-in slice). Mirrors the #42 governed-memory shape.

- [ ] **1. Skill substrate `skills.ts`** — `Skill` type (`name`, `version`,
      `capabilities[]`, `constraints[]`, `scope[]`, `instructions`, `scripts?`,
      `tests?`, `validation{lastValidatedRun?,lastValidatedAt?,status}`, `trust`,
      `createdAt`, `useCount`, `revalidateAfterDays?`), `allocateSkillName?`/
      `skillsDir`/`skillDir`/`skillManifestPath`, pure `parseSkill` (never throws),
      `listSkillIds`/`readSkill`/`readSkills`/`writeSkill` (`.otto/skills/<name>/
      skill.json` + `instructions.md`). Export from `index.ts`. INERT. Pinned by
      `skills.test.ts`.
- [ ] **2. Validation governance** — pure `skillStatus(skill, now)` →
      `validated`/`unvalidated`/`stale` from `validation.lastValidatedRun` +
      freshness policy (mirrors `memoryStatus`); `recordValidation(skill, runId,
      now)` pure copy. INERT. Pinned by `skills.test.ts`.
- [ ] **3. Retrieval `selectSkills`** — pure `selectSkills(skills, {assessment,
      changedPaths, capability})` → `SkillMatch[] {name, eligible, score, reasons}`,
      only `validated` skills eligible, ranked, with per-candidate reasons (the
      "why was this selected" metric). Uses `classifyRisk` + scope-glob match.
      INERT. Pinned by `skills.test.ts`.
- [ ] **4. Candidate identification `findSkillCandidates`** — pure heuristic over
      run summaries: group successful runs by `taskKey`/mode, surface ≥2-success
      keys as `SkillCandidate[] {key, runIds, count}`. INERT. Pinned by
      `skills.test.ts`.
- [ ] **5. `otto-skills` read-only bin** — `skills-cli.ts`: pure
      `formatSkillsReport`/`formatWhy` + thin `runSkills(argv, deps)` with `list`
      (skills + derived status), `audit` (usable/stale/unvalidated), `why`
      (given changed paths → `selectSkills` with reasons) subcommands. New
      `apps/cli/bin/otto-skills.js` + package.json `bin` + `index.ts` export.
      Read-only. Pinned by `skills-cli.test.ts`.
- [ ] **6. Run-report + eval surfacing** — optional `skillsUsed?: SkillUsage[]`
      on `RunManifest` + `StageRecord` (INERT, like `safetyEvents`); eval
      `skillUsageCount` over manifest + stages (unranked column). Pinned by
      `run-report.test.ts` + `eval.test.ts`.
- [ ] **7. Docs** — README (Why Otto skills bullet + `otto-skills` in How-it-works),
      `docs/ARCHITECTURE.md` (`skills.ts`/`skills-cli.ts` module-map rows + index
      re-exports + a "Skill extraction & reuse" section: package layout, validation
      gating, retrieval-by-risk/files/capability, inert-on-the-loop), a skill.json
      field reference.
