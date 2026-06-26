# PRD: Freebuff CLI agent runtime

> Source context: [Otto agent runtime issue #24](https://github.com/phamvuhoang/otto/issues/24), [PR #30](https://github.com/phamvuhoang/otto/pull/30), [Codex adapter issue #31](https://github.com/phamvuhoang/otto/issues/31), [Freebuff CLI](https://freebuff.com/cli), [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff).

> Phase 0 spike findings: [docs/spikes/freebuff-runtime-spike.md](../spikes/freebuff-runtime-spike.md) — conclusion: `requires-upstream`.

## 1. Executive Summary

Add Freebuff as a third Otto agent runtime only after a short CLI-contract spike proves it can satisfy Otto's unattended stage contract. The target experience is `otto-afk --agent freebuff ...` and `--fallback-agent freebuff --auto-switch-on-limit`, with the same runtime visibility, preflight, logs, resume, and fallback semantics already built for Claude and Codex. The main product risk is that Freebuff is currently documented and source-visible as an interactive terminal app, not a Codex-style `exec --json` runtime; therefore the first deliverable is a spike that either proves a stable headless path or blocks production support with a clear upstream requirement.

## 2. Problem Statement

Otto now supports a provider-neutral runtime boundary, but users who want a zero-cost coding agent cannot select Freebuff as the active runtime. The current runtime set is `claude | codex`, so operators who hit Claude/Codex usage limits cannot fall back to a free/ad-supported CLI from Otto's loop.

The Codex integration shows what "real support" means: not just spawning a binary, but proving non-interactive prompt execution, parseable stage results, error and rate-limit mapping, sandbox/auth/preflight behavior, runtime-labelled logs, model/env handling, and docs.

Freebuff is attractive because the product page positions it as a free terminal coding agent with no subscription and no API key. The Codebuff README says Freebuff is the free, ad-supported version of Codebuff and can edit code and run tests. However, the public Freebuff docs show `freebuff` as an interactive command, and the current Codebuff source indicates Freebuff mode does not accept initial prompt arguments. That means an Otto integration is not implementation-ready until the contract is verified against the real binary.

## 3. Target Users & Personas

### Primary Persona: Otto Operator

- Runs `otto-afk`, `otto-ghafk`, or `otto-linear-afk` for multi-iteration implementation and review.
- Wants a free runtime for lower-priority tasks, long-running chores, or fallback when a paid runtime is rate-limited.
- Needs to know exactly which runtime is active before the run spends time or changes files.

### Secondary Persona: Otto Maintainer

- Needs new runtime support to fit the existing `AgentRuntime` abstraction.
- Wants runtime additions to stay opt-in, tested, and honest about gaps.
- Needs failure modes to be deterministic rather than TUI hangs or unparseable output.

## 4. Strategic Context

Issue #24 created the runtime roadmap: visible runtime selection, provider-neutral adapter boundaries, Codex preflight, model env handling, and switch-on-limit. PR #30 delivered most of that foundation and documented the remaining Codex adapter gap. Issue #31 closed the gap by requiring a production Codex `AgentRuntime` adapter.

Freebuff should reuse that same path. A one-off Freebuff branch in `loop.ts` would reverse the abstraction work. The right product bet is to make Otto extensible to another agent CLI while preserving the guarantees users already rely on: visible runtime choice, clear preflight, safe stage execution, parseable outcomes, and no silent provider switches.

## 5. Solution Overview

Ship this as a spike-gated runtime initiative:

1. Add a Freebuff CLI spike, modeled on `docs/spikes/codex-runtime-spike.md` and `scripts/codex-spike.mjs`.
2. Verify whether the installed `freebuff` binary supports a headless prompt path, a machine-readable stream, deterministic completion, usable auth/session setup, and safe unattended command execution.
3. If the spike passes, add `freebuff` to the runtime set and implement a `freebuffRuntime` adapter behind `AgentRuntime`.
4. If the spike fails, do not expose `--agent freebuff` as a production option. Instead, document the blocker and the required upstream CLI contract, for example `freebuff exec --json <prompt>`.

The intended user-facing API, once the spike passes:

```bash
otto-afk --agent freebuff "./docs/plans/feature.md" 5
OTTO_AGENT=freebuff otto-ghafk 3
otto-afk --fallback-agent freebuff --auto-switch-on-limit "./docs/plans/feature.md" 20
```

`--print-config` should show Freebuff-specific CLI/session rows, the selection source, model/session mode when available, and whether fallback is configured.

## 6. Success Metrics

### Primary Metric

Successful unattended Freebuff stage completion:

- Target: `otto-afk --agent freebuff "<small plan>" 1` produces a committed change and a final Otto report without manual TUI input.

### Secondary Metrics

- Runtime observability: `--print-config`, run banner, stage banner, NDJSON log path, run summary, and run bundle all show `freebuff`.
- Reliability: Freebuff adapter unit tests cover argv, parser, preflight, error mapping, and runtime selection.
- Fallback: mocked switch-on-limit tests cover Claude -> Freebuff and Freebuff -> Claude once a production adapter exists.
- Documentation: README, `docs/CLI.md`, `docs/CONFIG.md`, `SECURITY.md`, and `docs/ARCHITECTURE.md` explain Freebuff status and limitations.

### Guardrails

- Default runtime remains Claude.
- No docs claim Freebuff execution works until a live headless smoke passes.
- Otto must not hang indefinitely inside a terminal UI.
- Otto must not silently run Freebuff unsandboxed when the operator expects `OTTO_RUNNER=sandbox`.

## 7. User Stories & Requirements

### Epic Hypothesis

We believe adding Freebuff as an opt-in runtime will make Otto more resilient and accessible for cost-sensitive runs because operators can use a free coding agent in the same implement-review loop. We will know it works when Freebuff can complete an unattended Otto stage with parseable output, visible runtime evidence, and safe failure behavior.

### Story 1: Freebuff contract spike

As a maintainer, I want a spike to verify Freebuff's CLI contract before production wiring, so that Otto does not ship a runtime that hangs or cannot report results.

Acceptance criteria:

- [ ] Spike records install/version behavior for the current `freebuff` package.
- [ ] Spike records whether prompt input works via argv, stdin, or a documented subcommand.
- [ ] Spike records whether output can be parsed into `StageResult`.
- [ ] Spike records auth/session/waiting-room behavior.
- [ ] Spike records sandbox and command-execution risks.
- [ ] Spike concludes `production-ready`, `blocked`, or `requires upstream CLI change`.

### Story 2: Runtime selection

As an operator, I want `--agent freebuff` and `OTTO_AGENT=freebuff`, so that I can select Freebuff explicitly for a run.

Acceptance criteria:

- [ ] `AgentRuntimeId` includes `freebuff` only after the spike passes.
- [ ] Invalid runtime errors still list all supported runtime ids.
- [ ] `--print-config --agent freebuff` reports selection source and Freebuff preflight rows.
- [ ] Existing Claude/Codex behavior is unchanged.

### Story 3: Freebuff adapter

As an operator, I want a Freebuff stage to run from Otto's rendered prompt file, so that Freebuff can implement, review, and commit in the same loop.

Acceptance criteria:

- [ ] `freebuffRuntime.buildArgs` passes the prompt through the verified headless path.
- [ ] `freebuffRuntime.createStreamParser` or `parseResultEvent` maps output into `StageResult`.
- [ ] `StageResult.runtimeId === "freebuff"`.
- [ ] Logs are runtime-labelled with `-freebuff.ndjson`.
- [ ] Claude-only and Codex-only flags are never passed to Freebuff.

### Story 4: Freebuff preflight

As an operator, I want Freebuff readiness checked before a run, so that missing binary/auth/session issues are caught before Otto starts.

Acceptance criteria:

- [ ] Preflight probes `freebuff --version`, not just PATH.
- [ ] Preflight detects the verified credential/session source.
- [ ] If Freebuff requires interactive login or model/session selection, preflight reports that a headless run is not ready.
- [ ] `--print-config --agent freebuff` shows Freebuff rows, not Claude/Codex rows.

### Story 5: Safe fallback

As an operator, I want Freebuff as a fallback runtime only when it can actually run unattended, so that switch-on-limit does not pause in a TUI.

Acceptance criteria:

- [ ] `--fallback-agent freebuff --auto-switch-on-limit` is accepted only when the adapter exists.
- [ ] Switching reason is visible in stderr, final summary, and state.
- [ ] If Freebuff is unavailable, Otto keeps the existing clear rate-limit wait behavior.

## 8. Out of Scope

- Driving Freebuff's interactive TUI with brittle keystroke automation.
- Shipping `--agent freebuff` before a headless contract is proven.
- Rebranding Codebuff paid behavior as Freebuff support.
- Replacing Claude/Codex defaults.
- Auto-selecting Freebuff without explicit operator configuration.
- Deriving precise USD cost from Freebuff unless the CLI exposes usage/cost data.

## 9. Dependencies & Risks

### Dependencies

- A working `freebuff` binary on a host where live smoke tests can run.
- Clear Freebuff auth/session behavior for unattended runs.
- A headless prompt and completion surface from Freebuff, or an upstream feature request to add one.
- Security decision for sandbox mode if Freebuff has no native sandbox.

### Risks

- Freebuff may not support non-interactive prompt execution.
- Freebuff may not expose machine-readable output or token usage.
- Freebuff's free session/waiting-room model may require interactive model selection.
- The CLI can run terminal commands; without sandbox support, a default sandbox run may be impossible.
- Freebuff package and source surfaces are evolving quickly, so the adapter may need version-gated parsing.

### Mitigations

- Make the spike the first phase.
- Fail closed for production support if headless execution is not proven.
- Keep Freebuff opt-in and loudly labelled.
- Use runtime-aware preflight and docs contracts the same way Codex did.
- Add version-specific fixtures for every parser shape that is accepted.

## 10. Open Questions

- Does the distributed `freebuff` binary have an undocumented headless mode even though public source/docs emphasize TUI usage?
- Can Freebuff accept a prompt via stdin and then exit after completion?
- Does Freebuff expose JSONL, logs, or an SDK event stream that can be safely treated as CLI output?
- What exact credential/session source should preflight check: no-auth bootstrap, `~/.config/manicode/credentials.json`, `CODEBUFF_API_KEY`, or something else?
- Can Freebuff run with a command/write sandbox suitable for Otto's `OTTO_RUNNER=sandbox` default?
- How should Otto represent Freebuff limits: rate limit, queue wait, country/region block, session ended, or model unavailable?
