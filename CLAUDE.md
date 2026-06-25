# CLAUDE.md

Guidance for Claude Code working in this repo. Behavioral rules: [.claude/CLAUDE.md](.claude/CLAUDE.md).

## What this is

Otto drives the Claude Code CLI (or Codex via `--agent codex`) against a target repo in an iterating implement → review loop. pnpm monorepo, two ESM packages:

- `@phamvuhoang/otto-core` (`packages/core`) — library: loop driver, renderer, stages, memory, skills (+ import/validate/activate), tools, extension profiles, model routing, fan-out, review panel, plan gate, context compression, reports, linear, journal. TS → `dist/`.
- `@phamvuhoang/otto` (`apps/cli`) — loop bins `otto-afk` (plan/PRD), `otto-ghafk` (GitHub issues), `otto-linear-afk` (Linear issues); operator bins `otto-inspect`, `otto-explain`, `otto-runs`, `otto-tail`, `otto-eval`, `otto-memory`, `otto-skills`, `otto-tools`, `otto-extensions`. Hand-written JS, no build.

## Commands

Node ≥20, pnpm ≥9. From repo root:

```bash
pnpm install
pnpm -r build        # compile packages/core/dist (only core builds)
pnpm -r typecheck
pnpm -r test         # core: vitest; root: node --test over scripts/*.test.mjs
```

Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit hook: prettier (lint-staged) + typecheck. Releases via release-please — **never hand-edit `version` fields or `.release-please-manifest.json`**.

## Architecture

Loop spine (`packages/core/src/`):

1. **`*-main.ts`** → **`run-bin.ts`** (`runBin`): parse flags (`cli-help.ts`), resolve dirs, call `runLoop` or `runWatch`.
2. **`loop.ts`** (`runLoop`): walks the stage chain per iteration. **First stage is the gate** — sentinel `<promise>NO MORE TASKS</promise>` exits. Wires model routing, fan-out, adaptive router, skill activation, cost/cooldown/signals, the plan gate, and report finalize (every terminal path).
3. **`render.ts`** (`renderTemplate`): expands `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}` per stage.
4. **`stage-exec.ts`** (`executeStage`): resolves model tier, appends injected skill context, wraps `runStage` in `withRetries`.
5. **`runner.ts`** (`runStage`): spawns `claude --print --output-format stream-json --permission-mode bypassPermissions`; sandbox mode writes a transient `--settings` confining writes. Returns the `result` payload.
6. **`stages.ts`**: stage defs (`name`, `template`, `permissionMode`, `tier`): `implementer`, `ghafkImplementer`, `ghafkIssueImplementer`, `linearImplementer`, `linearIssueImplementer`, `plan`, `verifier`, `applyReviewImplementer`, `reviewer`, `subImplementer`, `journalWrite`, `journalScreen`.

Topology (gate = index 0; reviewer never gates):

```
otto-afk         → [implementer,        reviewer]   inputs = "<plan-and-prd>"
otto-ghafk       → [ghafkImplementer,   reviewer]   inputs = ""
otto-linear-afk  → [linearImplementer,  reviewer]   inputs = ""
```

### Key systems

Each is **off by default and inert until opted in** (flag / env / `.otto/` config), so a bare run behaves as before.

| System             | Files                                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review & routing   | `panel.ts`, `review-severity.ts`, `risk.ts`, `model-tier.ts`, `fanout.ts`, `worktree.ts`                             | `--review-panel`: routed lens readers → adversarial verify → synth commits only CONFIRMED fixes (severity-ranked, nits suppressed, `structural` lens guards health). `--adaptive-router` routes review depth by change risk; `--model-routing` picks `cheap/mid/strong` per stage (pin wins); `--fan-out` runs `.otto/tasks/<key>/tasks.json` waves as worktree sub-agents, cherry-picked serially.   |
| Plan gate          | `plan-gate.ts`, `plan-rubric.ts`, `plan-checkpoint.ts`, `plan-artifacts.ts`                                          | `--plan`: presence + **depth** rubric → one re-plan on shortfall → pause; interactive approve/edit/reject (AFK auto-approves); scope-drift surfaced at finalize.                                                                                                                                                                                                                                      |
| Memory             | `memory.ts`                                                                                                          | `.otto/memory/<id>.json` governed records; `otto-memory audit/project`; projected into `LEARNINGS.md`, injected every prompt.                                                                                                                                                                                                                                                                         |
| Skills             | `skills.ts`, `external-skills.ts`, `skill-validation.ts`, `skill-activation.ts`, `skill-routing.ts`                  | `.otto/skills/<name>/` packages + imported packs (`sources.json` + `skills.lock.json`). `otto-skills sources/sync/validate/why`. `validate` → compatibility class `afk-safe\|interactive-only\|stage-scoped\|blocked` + behavior drills, persisted to `skill.json`. `--use-skills` injects validated, stage-scoped, char-bounded, attributed skill text → `skillsUsed[]` evidence. Validate ≠ select. |
| Tools & context    | `tools.ts`, `tools-cli.ts`, `context-budget.ts`, `context-report.ts`, `context-compressor.ts`, `headroom-adapter.ts` | `.otto/tools/<name>.json` typed adapters under policy scope; `otto-tools list/why/health`. `--context-compressor headroom` compresses `@spill` output (reversible, measured); `--context-report`/`--token-mode` measure budget. Personal MCP/plugin config is never inherited.                                                                                                                        |
| Extensions         | `extension-profiles.ts`, `extensions-cli.ts`                                                                         | `otto-extensions init <profile>` writes pinned sources + tools + config + policy as plain, diffable `.otto/` files (generated, not hidden). Profiles: `coding-superpowers`, `pm-planning`, `context-saver`, `security-review`.                                                                                                                                                                        |
| Safety             | `safety-policy.ts`, `taint.ts`                                                                                       | `.otto/policy.json` (blocked cmds, write roots, net domains, secret patterns, approval actions); untrusted inputs taint-fenced.                                                                                                                                                                                                                                                                       |
| Evidence & reports | `run-report.ts`, `report-finalize.ts`, `report-rubric.ts`, `report-explain.ts`                                       | `.otto/runs/<run-id>/` per run (stage records, manifest, report); `otto-inspect/explain/runs/tail`. Outcome-first quality report; legibility rubric → one-shot `report-rewrite`; harness fallback when an agent emits none; every mode emits one.                                                                                                                                                     |
| Eval               | `eval-run.ts`, `bench.ts`, `eval.ts`                                                                                 | `otto-eval compare/benchmarks`; A/B recorded runs without re-paying.                                                                                                                                                                                                                                                                                                                                  |
| Journal            | `journal.ts`, `journal-gate.ts`, `threads-api.ts`                                                                    | End-of-run field note; triple secrecy gate; Threads publish; double opt-in to post.                                                                                                                                                                                                                                                                                                                   |
| Linear             | `linear-api.ts`, `linear-main.ts`                                                                                    | `OTTO_LINEAR_API_KEY`; `otto-linear-auth login`.                                                                                                                                                                                                                                                                                                                                                      |

### Template renderer (most likely to bite you)

Tags expand in order — `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`:

- `@include:<path>` — inline a file; no shell. Injects playbooks into iteration templates.
- `` @spill[?]:<name>=`cmd` `` — run cmd, write stdout to a spill file, substitute its path. Keeps large output (patches, issue bodies) out of the inline prompt.
- `` !?`cmd|||fallback` `` — try-shell; non-zero → fallback. **Prefer over `!` for any command that may be absent on Windows.**
- `` !`cmd` `` — plain shell (`cwd = workspaceDir`); failure aborts the iteration.
- `{{ INPUTS }}` — replaced with the `inputs` string.

## Conventions

- **ESM only.** Relative imports in `packages/core/src/` end in `.js` (NodeNext).
- **First stage is the gate.** Sentinel hardcoded in `loop.ts`; gating stages go at index 0.
- **No build for `apps/cli`.** Hand-written JS; keep the bin layer flat.
- **New stage:** (1) add to `STAGES` with a `tier`, (2) add `templates/<name>.md`, (3) wire into the chain in the relevant `*-main.ts`. Templates ship in the tarball. Harness-orchestrated sub-stages (panel lens/verify/synth in `panel.ts`, `report-rewrite` in `loop.ts`) are local `Stage` consts run via `executeStage` — not in `STAGES` or a chain.
- **`permissionMode` is always `bypassPermissions`.** Blast radius bounded by the sandbox runner.
- **Opt-in features stay inert by default.** Imported skills/tools register `unverified`/policy-scoped; nothing influences a run until validated + activated.
- **Never hand-edit release version state.** release-please owns it.

## Orientation

- `README.md` — user docs: all flags, env vars, real-world scenarios + recipes.
- `docs/CLI.md`, `docs/ARCHITECTURE.md`, `docs/EXTENSIONS.md` — command reference, runtime internals, extension profiles.
- `packages/core/templates/{prompt,ghprompt,linearprompt}.md` — agent playbooks (edit to change feedback loops); `templates/<stage>.md` + `templates/lens-guidance/*.md` — stage templates.
- `.otto/policy.json` — safety governance. `.otto/config.json` — agent, branch, journal, `skills` activation, `contextCompressor`, `tools` overrides. `.otto/skills/`, `.otto/tools/` — repo-local extension registries.
