# AGENTS.md

Guidance for Codex working in this repo. Behavioral rules: [.Codex/AGENTS.md](.Codex/AGENTS.md).

## What this is

Otto drives the Claude Code CLI (or Codex via `--agent codex`) against a target repo in an iterating implement → review loop. pnpm monorepo, two ESM packages:

- `@phamvuhoang/otto-core` (`packages/core`) — library: loop driver, runner, template renderer, stage registry, memory, skills, model routing, fan-out, review panel, linear, journal. TS → `dist/`.
- `@phamvuhoang/otto` (`apps/cli`) — loop bins: `otto-afk` (plan/PRD), `otto-ghafk` (GitHub issues), `otto-linear-afk` (Linear issues). Operator bins: `otto-inspect`, `otto-explain`, `otto-runs`, `otto-tail`, `otto-eval`, `otto-memory`, `otto-skills`. Hand-written JS, no build.

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
2. **`loop.ts`** (`runLoop`): walks stage chain per iteration. **First stage is the gate** — sentinel `<promise>NO MORE TASKS</promise>` exits the loop. Wires model routing, fan-out, adaptive router, cost accounting, cooldown, signals.
3. **`render.ts`** (`renderTemplate`): expands `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}` before each stage.
4. **`stage-exec.ts`** (`executeStage`): resolves model tier via `resolveStageModel`, wraps `runStage` in `withRetries`.
5. **`runner.ts`** (`runStage`): spawns the active agent CLI (`claude` or `codex`) with `--print --output-format stream-json --permission-mode bypassPermissions`; sandbox mode writes a transient `--settings` confining writes. Returns the `result` payload.
6. **`stages.ts`**: all stage definitions — `name`, `template`, `permissionMode`, `tier`. Current: `implementer`, `ghafkImplementer`, `ghafkIssueImplementer`, `linearImplementer`, `linearIssueImplementer`, `plan`, `verifier`, `applyReviewImplementer`, `reviewer`, `subImplementer`, `journalWrite`, `journalScreen`.

Topology (gate = index 0; reviewer never gates):

```
otto-afk         → [implementer,        reviewer]   inputs = "<plan-and-prd>"
otto-ghafk       → [ghafkImplementer,   reviewer]   inputs = ""
otto-linear-afk  → [linearImplementer,  reviewer]   inputs = ""
```

### Key systems

| System | Files | Notes |
|---|---|---|
| Review panel | `panel.ts` | `--review-panel`: lens readers → adversarial verifier → synth commits only CONFIRMED fixes |
| Watch daemon | `watch.ts` | `--watch`: polls `OTTO_WATCH_LABEL`/`OTTO_LINEAR_LABEL` (default `otto`); ghafk + linear only; fan-out unavailable in watch mode |
| Model routing | `model-tier.ts` | `--model-routing`: `cheap/mid/strong` tiers via `TierLadder`; escalates on failure; pin wins |
| Fan-out | `fanout.ts`, `worktree.ts` | `--fan-out`: reads `.otto/tasks/<key>/tasks.json`, runs wave tasks as worktree sub-agents, cherry-picks serially; conflict → defers |
| Memory | `memory.ts` | `.otto/memory/<id>.json` records; `otto-memory audit/project`; rendered into `LEARNINGS.md` injected every prompt |
| Skills | `skills.ts` | `.otto/skills/`; `otto-skills candidates/why/list`; must be validated before use |
| Safety | `safety-policy.ts`, `taint.ts` | `.otto/policy.json` (blocked cmds, write roots, net domains, secret patterns); untrusted inputs taint-fenced |
| Evidence | `run-report.ts` | `.otto/runs/<run-id>/` per run; `otto-inspect`, `otto-explain`, `otto-runs`, `otto-tail` |
| Journal | `journal.ts`, `journal-gate.ts`, `threads-api.ts` | End-of-run field note; triple secrecy gate; Threads publish; double opt-in to post |
| Linear | `linear-api.ts`, `linear-main.ts` | `OTTO_LINEAR_API_KEY`; `otto-linear-auth login` |
| Eval | `eval-run.ts`, `bench.ts` | `otto-eval compare/benchmarks`; A/B runs without re-paying |

### Template renderer (most likely to bite you)

Tags expand in order — `@include` → `@spill` → `!?` → `!` → `{{ INPUTS }}`:

- `@include:<path>` — inline a file; no shell. Injects playbooks into iteration templates.
- `` @spill[?]:<name>=`cmd` `` — run cmd, write stdout to spill file, substitute path into prompt. Keeps large output (patches, issue bodies) out of inline prompt.
- `` !?`cmd|||fallback` `` — try-shell; non-zero → fallback. **Prefer over `!` for any command that may be absent on Windows.**
- `` !`cmd` `` — plain shell (`cwd = workspaceDir`); failure aborts iteration.
- `{{ INPUTS }}` — replaced with the `inputs` string.

## Conventions

- **ESM only.** Relative imports in `packages/core/src/` end in `.js` (NodeNext).
- **First stage is the gate.** Sentinel hardcoded in `loop.ts`; gating stages go at index 0.
- **No build for `apps/cli`.** Hand-written JS; keep bin layer flat.
- **New stage checklist:** (1) add to `STAGES` with `tier`, (2) add `templates/<name>.md`, (3) wire into chain in the relevant `*-main.ts`. Templates ship in the tarball.
- **`permissionMode` is always `bypassPermissions`.** Blast radius bounded by the sandbox runner.
- **Never hand-edit release version state.** release-please owns it.

## Orientation

- `README.md` — user docs, all flags, env vars, use-case recipes.
- `docs/ARCHITECTURE.md` — runtime internals for library extenders.
- `packages/core/templates/prompt.md`, `ghprompt.md`, `linearprompt.md` — agent playbooks (edit to change feedback loops).
- `packages/core/templates/{afk,ghafk,linearafk,review,review-lens,review-synth,subtask,journal-write,journal-screen}.md` — stage templates.
- `.otto/policy.json` — repo-local safety governance. `.otto/config.json` — journal + branch config.
