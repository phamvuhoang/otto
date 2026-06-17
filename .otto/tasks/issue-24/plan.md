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

- [ ] **Extract an `AgentRuntime` contract; make the Claude adapter the default.**
      Move `buildClaudeArgs`/`streamClaude`/result-parse/rate-limit-detect behind
      an `AgentRuntime` object; `StageResult` carries the producing runtime id.
      Claude behavior byte-for-byte unchanged; tests pin runtime selection.

## P2 — Codex spike

- [ ] **Codex CLI adapter spike (throwaway harness + findings doc).** Prove
      non-interactive prompt-file invocation, machine-readable output → StageResult
      mapping, auth/preflight detection, sandbox model. Document known gaps.

## P3 — stable Codex

- [ ] **Codex `AgentRuntime` adapter behind `--agent codex`.** Args builder,
      output parser, preflight row, runtime-labelled logs; don't pass Claude-only
      flags to Codex.
- [ ] **Provider-specific model/env handling** (`OTTO_CLAUDE_MODEL` /
      `OTTO_CODEX_MODEL`, applied to the selected runtime; `OTTO_MODEL` precedence
      documented).

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
