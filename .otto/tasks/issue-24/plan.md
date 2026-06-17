# issue-24 — Otto Agent Runtime — plan

Built in the issue's recommended order. One `- [ ]` = one bite-sized, testable
task. Implement the first unchecked task per run.

## P0/P1 — runtime config + visibility

- [x] **Runtime config parsing + resolver + `--print-config` visibility.**
      `agent-runtime.ts` (`parseAgentId`, `resolveAgentRuntime`, `readAgentConfig`,
      `AGENT_DISPLAY_NAMES`, `DEFAULT_AGENT`); `--agent` flag; run-bin resolves
      flag→env→config→default (invalid env/config reported by `--print-config`,
      fatal on real run); `--print-config` shows runtime + display name + source;
      a non-claude real run exits 1 "not implemented yet". Default stays Claude.
- [x] **Runtime in run banner, stage banner, log path, and final summary.**
      `runtime: Claude Code` on the version banner; `· Claude Code` on the stage
      banner; `-<runtime>` suffix on the NDJSON log filename; `runtime: claude`
      on the summary line. Thread resolved runtime into `runLoop`.

## P0 — adapter boundary

- [x] **Extract an `AgentRuntime` contract; make the Claude adapter the default.**
      `AgentRuntime` type + `claudeRuntime` adapter + `getAgentRuntime(id)` selector
      in `runner.ts`; `streamClaude`→`streamRuntime(runtime)` routes through
      `runtime.buildArgs`/`parseResultEvent`/`command`/`supportsSandboxSettings`;
      `StageResult.runtimeId` stamps the producing runtime; `stage-exec` selects
      the adapter from `agentId`. Claude behavior byte-for-byte unchanged; tests
      pin selection + adapter output. (Rate-limit detect left in `rate-limit.ts`
      for now — generic, Codex's shape is unknown until the P2 spike; not moved.)

## P2 — Codex spike

- [x] **Codex CLI adapter spike (throwaway harness + findings doc).** Prove
      non-interactive prompt-file invocation, machine-readable output → StageResult
      mapping, auth/preflight detection, sandbox model. Document known gaps.
      Harness + candidate parser/preflight/argv in `scripts/codex-spike.mjs`
      (throwaway, not shipped), pinned by `scripts/codex-spike.test.mjs`; findings
      in `docs/spikes/codex-runtime-spike.md`. **Live smoke BLOCKED here** —
      Codex 0.104.0's native binary is missing (ENOENT, empty `vendor/`), so the
      `exec --json` event schema is documented as UNVERIFIED; P3's first step is
      to confirm it against a working binary.

## P3 — stable Codex

- [x] **Codex preflight in `--print-config` (runtime-aware).** `runPreflight`
      takes the resolved `agentId`; a codex run shows `codex CLI` + `codex auth`
      rows instead of claude's. The CLI row probes `codex --version` succeeds
      (injectable `probeVersion`), not just PATH presence — a shim-present /
      native-binary-broken Codex reports **unusable**, closing spike gap #5 (and
      empirically confirmed on this host: the official 0.104.0 binary SIGKILLs).
      Auth = `~/.codex/auth.json` OR `OPENAI_API_KEY`. Pinned by
      `preflight.test.ts` + `cli-help.test.ts`.
- [ ] **Codex `AgentRuntime` adapter behind `--agent codex`.** Args builder
      (`codex exec --json --sandbox … --ask-for-approval never`, `-m` model),
      output parser, runtime-labelled logs, remove the run-bin "not implemented"
      guard; don't pass Claude-only flags to Codex. **BLOCKED on this host:** the
      adapter's `parseResultEvent` depends on the `codex exec --json` event schema
      the P2 spike flagged UNVERIFIED, and no working Codex binary can run here
      (vendored native binary missing; a freshly-downloaded, validly-signed
      official binary is SIGKILL'd by this environment). Promoting unverified
      parsing into the runner hot path violates the P0 "stays generic until the
      spike reveals the shape" call — do it on a host where `codex exec --json`
      actually runs and the fixtures can be diffed against a live stream.
- [x] **Provider-specific model/env handling** (`OTTO_CLAUDE_MODEL` /
      `OTTO_CODEX_MODEL`, applied to the selected runtime; `OTTO_MODEL` precedence
      documented). `resolveModelSelection(runtimeId, env)` in `runner.ts` picks
      `OTTO_<RUNTIME>_MODEL` over `OTTO_MODEL` (empty/whitespace override falls
      through), returns `{spec, source}`; `runStage` feeds its `.spec` into the
      existing `resolveModelArgs`, so the per-runtime override reaches the spawned
      CLI. `--print-config`'s model line is runtime-aware (value + source env var,
      or `<runtime> CLI default (OTTO_<RUNTIME>_MODEL / OTTO_MODEL unset)`). Help
      text documents precedence. Pinned by `runner.test.ts` + `cli-help.test.ts`.
      (The Codex adapter above stays blocked — this task is independent of it.)

## P4 — auto-switch on limits

- [ ] **Fallback config** (`--fallback-agent`, `OTTO_FALLBACK_AGENT`,
      `--auto-switch-on-limit` / `OTTO_AUTO_SWITCH_ON_LIMIT`; default off).
- [ ] **Switch-on-limit at retry/stage boundary**, recorded in state + visible in
      stderr/summary; budget survives the switch; resume keeps the fallback unless
      `--fresh`.

## P5 — docs + smoke

- [ ] **Docs + smoke tests** (README, docs/CLI.md, docs/CONFIG.md, SECURITY.md,
      ARCHITECTURE; smoke: Claude default, Codex preflight-fails-clean, runtime
      visible in config/banner, auto-switch mocked path).
