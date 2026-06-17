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

- [x] **Fallback config** (`--fallback-agent`, `OTTO_FALLBACK_AGENT`,
      `--auto-switch-on-limit` / `OTTO_AUTO_SWITCH_ON_LIMIT`; default off).
      Pure `resolveFallback`/`readFallbackConfig` in `agent-runtime.ts` (fallback
      agent has NO default → unset = off; auto-switch flag→env-truthy→config→false);
      `--fallback-agent`/`--auto-switch-on-limit` flags; run-bin resolves +
      reports a `fallback` line in `--print-config` (`<id> (<name>, <source>) ·
      auto-switch on|off`, or `off`, or `auto-switch on · no fallback agent set`,
      or `invalid (…)`); an invalid env/config value is reported by
      `--print-config` (exit 0) and fatal on a real run (mirrors the agent
      handling). Config-only slice — the actual switch is the next task. Pinned by
      `agent-runtime.test.ts` + `cli-help.test.ts` + `run-bin.test.ts`.
- [x] **Switch-on-limit at retry/stage boundary**, recorded in state + visible in
      stderr/summary; budget survives the switch; resume keeps the fallback unless
      `--fresh`. `runLoop` now carries `fallbackAgentId`/`fallbackAgentDisplayName`/
      `autoSwitchOnLimit`; an active runtime is tracked mutably (`activeAgentId`)
      and reassigned in the rate-limit catch when a fallback is configured and not
      already active — re-running the stage on the fallback instead of waiting
      (accounting already rolled back to the snapshot, so budget survives). Only
      one switch (active===fallback ⇒ wait/halt), so a fallback that also limits
      still halts cleanly. `RunState.agent` persists the active runtime so a resume
      restores the fallback (`--fresh` clears state → primary). Summary shows
      `runtime: <primary> -> <fallback> (switched once: rate limit)`; stderr prints
      the switch line. Wired from run-bin's `fallback.*` into both the direct
      `runLoop` and `runWatch`. Pinned by `loop.test.ts` (switch claude↔codex,
      off→wait, fallback-also-limits→wait, resume-keeps-fallback).
      **End-to-end cross-provider switching stays gated on the Codex adapter
      (above, BLOCKED): a real switch to codex hits getAgentRuntime's "not
      implemented" throw. The orchestration is provider-neutral + fully unit-tested
      with mocked runtimes; it becomes runnable when the codex adapter lands.**

## P5 — docs + smoke

- [x] **Docs + smoke tests** (README, docs/CLI.md, docs/CONFIG.md, SECURITY.md,
      ARCHITECTURE). All five surfaces now document the agent runtime: a new
      `## Agent runtime (--agent)` section in CLI.md (flags table,
      flag→env→config→default precedence, `--print-config`/banner/log/summary
      visibility, provider-specific model env, honest "codex selectable but
      adapter not yet shipped" status); CONFIG.md env-var rows for `OTTO_AGENT` /
      `OTTO_FALLBACK_AGENT` / `OTTO_AUTO_SWITCH_ON_LIMIT` / `OTTO_CLAUDE_MODEL` /
      `OTTO_CODEX_MODEL` + a runtime-aware preflight note (codex CLI/auth, probes
      `codex --version`); README runtime flags/env + a `--print-config` example;
      SECURITY.md per-runtime credential/sandbox note (claude `~/.claude` +
      `--settings`; codex `~/.codex/auth.json`/`OPENAI_API_KEY` + its own
      `--sandbox`); ARCHITECTURE.md `### Agent runtime abstraction` (the
      `AgentRuntime` contract, `getAgentRuntime`, sole `claudeRuntime` adapter,
      codex-not-implemented throw, provider-neutral switch in `loop.ts`).
      Pinned by `scripts/agent-runtime-doc-contract.test.mjs` (drift-proof: parses
      `AGENT_DISPLAY_NAMES`/`DEFAULT_AGENT` + flag names from source, asserts every
      doc reflects them; the repo's established doc-contract pattern). **The four
      P5 smoke scenarios are already covered by unit tests** — Claude default
      config/banner + runtime-visible-in-config (`cli-help.test.ts`,
      `loop.test.ts`), codex preflight-fails-clean (`preflight.test.ts` injected
      probes), auto-switch mocked-limit path (`loop.test.ts`) — so no redundant new
      smoke harness was added (YAGNI); the doc-contract test is the docs regression
      guard. **The Codex adapter task above stays the only open P5/P3 item, BLOCKED
      on a runnable codex binary (still ENOENT on this host).**
