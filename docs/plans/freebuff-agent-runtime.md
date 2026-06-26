# Plan: Freebuff CLI agent runtime

> PRD: [docs/prd/freebuff-agent-runtime.md](../prd/freebuff-agent-runtime.md)  
> Spec: [docs/specs/freebuff-agent-runtime.md](../specs/freebuff-agent-runtime.md)

## Build Principles

- Reuse the `AgentRuntime` boundary built for Claude/Codex.
- Spike before exposing a production runtime.
- Fail closed on interactive-only or unsandboxed behavior.
- Keep default Claude behavior unchanged.
- Keep runtime visibility complete: config, banner, stage logs, summary, run bundle.

## Phase 0: Freebuff CLI Contract Spike

Goal: determine whether Freebuff can run an Otto stage unattended.

### Tasks

- [ ] Create `docs/spikes/freebuff-runtime-spike.md`.
- [ ] Create `scripts/freebuff-spike.mjs` with candidate preflight, argv builder, parser, limit detector, and live smoke entrypoint.
- [ ] Create `scripts/freebuff-spike.test.mjs` with no-binary unit fixtures.
- [ ] Probe `freebuff --version` and record launcher/native-binary failure modes.
- [ ] Test prompt input modes: argv, stdin, prompt file, documented/hidden subcommands.
- [ ] Test completion behavior: does the child exit after one task?
- [ ] Test output behavior: JSONL, plain text, log file, or TUI-only.
- [ ] Test credentials/session behavior: first-run setup, stored credentials, `CODEBUFF_API_KEY`, Freebuff waiting-room states.
- [ ] Test command/sandbox behavior: whether Freebuff has a non-interactive sandbox or approval mode.

### Acceptance Criteria

- [ ] Spike ends with one of:
  - `production-ready`: headless prompt + parseable output + safe execution path proven.
  - `blocked`: no reliable headless contract.
  - `requires-upstream`: specific Freebuff CLI feature needed, such as `freebuff exec --json`.
- [ ] No production `--agent freebuff` support ships from this phase.
- [ ] Findings are linked from the PRD/spec.

## Phase 1: Runtime Config Surface

Proceed only if Phase 0 is `production-ready`.

### Tasks

- [ ] Extend `AgentRuntimeId` to `claude | codex | freebuff`.
- [ ] Add `AGENT_DISPLAY_NAMES.freebuff = "Freebuff CLI"`.
- [ ] Update `parseAgentId`, help text, config output, and fallback validation.
- [ ] Update tests that assert accepted runtime ids.
- [ ] Update doc-contract tests to include Freebuff only once production support exists.

### Acceptance Criteria

- [ ] `--print-config --agent freebuff` resolves the runtime without spawning a stage.
- [ ] Invalid runtime messages include `freebuff`.
- [ ] Existing Claude/Codex tests still pass.

## Phase 2: Preflight

### Tasks

- [ ] Add a Freebuff branch to `runPreflight`.
- [ ] Probe `freebuff --version`.
- [ ] Detect verified credential/session readiness.
- [ ] Report interactive setup blockers clearly.
- [ ] Include workspace git row as today.
- [ ] Add preflight tests for present, missing, broken, authed, unauthenticated, and interactive-only cases.

### Acceptance Criteria

- [ ] `--print-config --agent freebuff` shows Freebuff rows and hides Claude/Codex rows.
- [ ] Broken launcher/native binary is reported as unusable.
- [ ] Missing headless readiness prevents a real run before mutation.

## Phase 3: Freebuff Runtime Adapter

### Tasks

- [ ] Add `buildFreebuffArgs` using the verified headless command.
- [ ] Add `createFreebuffStreamParser` or `parseFreebuffResultEvent`.
- [ ] Add `detectFreebuffLimit` / `resetsAtFromFreebuffEvent` as supported by output.
- [ ] Add `buildFreebuffEnv` if credentials or mode env vars need child-process mapping.
- [ ] Register `freebuffRuntime` in `AGENT_RUNTIMES`.
- [ ] Ensure `supportsSandboxSettings` and `OTTO_RUNNER` behavior match the verified sandbox contract.
- [ ] Ensure Claude-only `--settings` and Codex-only flags are never emitted.

### Acceptance Criteria

- [ ] Unit tests prove argv shape and parser mapping.
- [ ] `StageResult.runtimeId === "freebuff"`.
- [ ] NDJSON logs use `-freebuff.ndjson`.
- [ ] Non-zero exit and terminal Freebuff session states produce clear Otto errors.
- [ ] `OTTO_RUNNER=sandbox` fails closed if Freebuff has no sandbox.

## Phase 4: Loop, Fallback, and State

### Tasks

- [ ] Run existing loop tests with Freebuff as the selected mocked runtime.
- [ ] Add switch-on-limit tests for Claude -> Freebuff and Freebuff -> Claude.
- [ ] Ensure `RunState.agent` persists Freebuff after fallback and resume.
- [ ] Ensure budget/token accounting tolerates missing Freebuff token/cost data.
- [ ] Ensure report finalize and inspect surfaces render Freebuff runtime names.

### Acceptance Criteria

- [ ] `--fallback-agent freebuff --auto-switch-on-limit` switches only when the adapter is available.
- [ ] If Freebuff is also limited/unavailable, Otto falls back to the existing wait/stop behavior.
- [ ] Final summary shows `runtime: claude -> freebuff` when switched.

## Phase 5: Docs and Security Review

### Tasks

- [ ] Update `README.md` examples and prerequisites.
- [ ] Update `docs/CLI.md` runtime section.
- [ ] Update `docs/CONFIG.md` env/preflight details.
- [ ] Update `docs/ARCHITECTURE.md` runtime adapter section.
- [ ] Update `SECURITY.md` with Freebuff command execution, credentials, data, and sandbox notes.
- [ ] Link `docs/spikes/freebuff-runtime-spike.md` from architecture/docs.
- [ ] Add/update doc-contract tests so docs cannot drift from runtime ids.

### Acceptance Criteria

- [ ] Docs do not imply Freebuff is supported before the adapter exists.
- [ ] After adapter support lands, docs include a runnable Freebuff example.
- [ ] Security docs are explicit about host-mode requirements if no sandbox exists.

## Phase 6: Live Smoke

Run only on a machine with a working Freebuff binary and verified session setup.

### Tasks

- [ ] `otto-afk --agent freebuff --print-config`
- [ ] `otto-afk --agent freebuff "./docs/plans/<small-plan>.md" 1`
- [ ] `OTTO_AGENT=freebuff otto-ghafk --print-config`
- [ ] Mocked or live fallback smoke if rate-limit/session-limit simulation is possible.
- [ ] Capture one representative Freebuff output fixture into tests.

### Acceptance Criteria

- [ ] A real Freebuff stage completes without manual input.
- [ ] The run commits or cleanly reports no-op according to Otto's normal loop rules.
- [ ] Run summary and `.otto/runs/<run-id>/stages/*` record Freebuff.
- [ ] Parser fixture matches the live output.

## Release Notes

- Conventional commit should be `feat(agent): add Freebuff runtime support` only if production support lands.
- If only Phase 0 lands, use `spike(agent): investigate Freebuff runtime contract` or `docs(agent): document Freebuff runtime spike`.
- Do not hand-edit package versions or `.release-please-manifest.json`; release-please owns version state.

## Stop Conditions

Stop before production runtime changes if any of these are true:

- Freebuff cannot accept a prompt non-interactively.
- Freebuff cannot exit deterministically after one task.
- Freebuff output cannot be mapped to `StageResult`.
- Freebuff requires manual waiting-room/model selection for every run.
- Freebuff has no sandbox and product decision rejects host-only execution.
