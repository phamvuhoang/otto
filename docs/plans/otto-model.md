# Plan: `OTTO_MODEL` env knob to pin the sandbox Claude model

> Source PRD: [phamvuhoang/otto#35](https://github.com/phamvuhoang/otto/issues/35) (mirror in `docs/prd/otto-model.md`) — pass `--model` through to the sandbox `claude` invocation so the run's model is decoupled from the image's frozen CLI default.
>
> **Target release**: `@phamvuhoang/otto-core` **0.7.0** (minor bump from 0.6.1 — new env knob). Driven by release-please from the `feat(core): …` commit that lands the implementation; no manual `package.json` / `.release-please-manifest.json` edits. CLI (`@phamvuhoang/otto`) is not bumped unless a sibling commit in the same release cycle touches the bins. Sandbox image (`packages/core/templates`) is unaffected.

## Architectural decisions

Durable decisions that apply across the implementation:

- **Env var contract**: `OTTO_MODEL`. Non-empty → `--model <value>` passed verbatim to the sandbox `claude` invocation. Unset / empty / whitespace-only → no flag (today's behavior, byte-for-byte). No validation — the `claude` CLI owns model-spec errors.
- **New pure helper**: `resolveModelArgs(raw: string | undefined): string[]` colocated in `packages/core/src/runner.ts`. Takes its raw string as an argument (does not read `process.env` internally), so it is unit-testable in isolation — mirrors `parseGraceMs`. Returns `["--model", trimmed]` or `[]`.
- **Call site**: `runStage` reads `process.env.OTTO_MODEL` and splices `...resolveModelArgs(...)` into the `claude …` argv after `--output-format stream-json` (around the existing `--permission-mode` push). Flag order is irrelevant; the positional prompt stays last. This matches how `OTTO_IMAGE` / `OTTO_DOCKER_SOCK` are read directly from `process.env` in the runner.
- **Surfacing**: one line in `printConfig` (cli-help.ts) showing the resolved model (value or `sandbox CLI default`), and one `OTTO_MODEL` entry in the `printHelp` env block.
- **Uniform across stages and bins**: both stages of a chain (implementer / ghafkImplementer + reviewer) and both bins (`otto-afk`, `otto-ghafk`) read the same env var; no per-stage override, no bin flag.
- **Verification standard**: `pnpm -r typecheck` + `pnpm -r test` (new `resolveModelArgs` unit cases) + manual smoke. The argv splicing and docker spawn stay manual-smoke per repo convention (shallow glue isn't unit-tested).

---

## Phase 1: `OTTO_MODEL` knob, end-to-end

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 (all PRD stories).

### What to build

End-to-end behavior: when `OTTO_MODEL` is set to a non-empty value, every sandbox stage of `otto-afk` / `otto-ghafk` runs `claude` with `--model <value>`, so the stream's `init model=…` line reflects the operator's choice instead of the image's frozen default. When `OTTO_MODEL` is unset (or empty/whitespace), no `--model` flag is added and behavior is identical to today. The resolved model is visible in `--print-config` and documented in `--help`, CLAUDE.md, and the README env table. The model-resolution rule lives in a small pure helper unit-tested alongside `parseGraceMs`.

### Acceptance criteria

- [ ] `pnpm -r typecheck` is clean from the repo root.
- [ ] `pnpm -r test` is green, including new `resolveModelArgs` cases: `undefined` → `[]`, `""` → `[]`, whitespace-only → `[]`, `"opus"` → `["--model", "opus"]`, `"claude-opus-4-8"` → `["--model", "claude-opus-4-8"]`, `"  opus  "` → `["--model", "opus"]` (trimmed).
- [ ] The new test suite lives in `packages/core/src/__tests__/runner.test.ts` next to the existing `parseGraceMs` suite, same vitest style.
- [ ] With `OTTO_MODEL=<id>` set, a manual smoke run shows the sandbox stream `init model=<id>` line matching the value (verified for both `otto-afk` and a `otto-ghafk` invocation).
- [ ] With `OTTO_MODEL` unset, the produced `claude …` argv contains no `--model` flag and behavior is unchanged (regression-free for existing users).
- [ ] With `OTTO_MODEL` empty or whitespace-only, no `--model` flag is added (treated as unset).
- [ ] `otto-afk --print-config` shows a `model` line: the `OTTO_MODEL` value when set, or `sandbox CLI default` (with a `OTTO_MODEL` marker) when unset. Same for `otto-ghafk --print-config`.
- [ ] `otto-afk --help` / `otto-ghafk --help` document `OTTO_MODEL` in the "Environment variables" block (pass-through `--model`, unset = sandbox CLI default).
- [ ] `CLAUDE.md` env-knobs list and the README "Running AFK" env table document `OTTO_MODEL`, matching the surrounding entries' style.
- [ ] `resolveModelArgs` reads no `process.env` internally (raw string in, argv fragment out); the `process.env.OTTO_MODEL` read happens only at the `runStage` call site.
- [ ] No new dependencies in any `package.json`. No new source files outside the `docs/prd/` + `docs/plans/` mirrors and the test additions.
- [ ] Local published-shape smoke after the change: `pnpm -r build`, re-pack both packages, global-install, and confirm `otto-afk --print-config` reports the model knob.
