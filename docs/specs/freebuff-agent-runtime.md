# Spec: Freebuff CLI agent runtime

> PRD: [docs/prd/freebuff-agent-runtime.md](../prd/freebuff-agent-runtime.md)

## Status

Spike-gated. Do not expose `freebuff` as a production `--agent` value until the Freebuff CLI contract is verified against a working binary.

> Phase 0 spike findings: [docs/spikes/freebuff-runtime-spike.md](../spikes/freebuff-runtime-spike.md) — conclusion: `requires-upstream`.

## Grounding

### Codex integration lessons

The Codex integration introduced the shape Freebuff should follow:

- `AgentRuntimeId` currently supports `claude | codex` in `packages/core/src/agent-runtime.ts`.
- `AgentRuntime` in `packages/core/src/runner.ts` owns provider-specific `command`, `buildArgs`, `parseResultEvent`, optional stream parser, optional reset-time extraction, optional child env mapping, and sandbox-settings support.
- `codexRuntime` uses `codex exec --json`, its own sandbox vocabulary, a stream parser for `item.completed` + `turn.completed`, opportunistic rate-limit reset extraction, and `OPENAI_API_KEY` -> `CODEX_API_KEY` child-env mapping.
- `runPreflight` is runtime-aware: a Codex run shows Codex CLI/auth checks and hides Claude checks.
- `loop.ts` switch-on-limit is provider-neutral once the adapter exists.

### Freebuff current surface

Verified from public sources:

- Freebuff product page: install with `npm install -g freebuff`; run `freebuff`; no API key; free/ad-supported.
- Codebuff README: Freebuff is the free, ad-supported version of Codebuff; Codebuff/Freebuff can edit files and run tests.
- npm metadata: `freebuff` publishes a `freebuff` bin and installs a platform binary under the user's config area.
- Codebuff source: Freebuff mode's argument parser exposes `--continue`, `--cwd`, `login`, help, and version; it intentionally does not accept initial prompt args. Codebuff mode accepts `[prompt...]`.
- Codebuff source: auth credentials are read from `~/.config/manicode/credentials.json` or `CODEBUFF_API_KEY`; Freebuff session status includes queued, active, rate_limited, country_blocked, banned, takeover_prompt, ended, and model_unavailable.

Implication: Freebuff is not currently proven to satisfy Otto's non-interactive stage contract. The first engineering deliverable is a spike, not production adapter wiring.

## Runtime contract Otto needs

Freebuff must satisfy all required fields before production support:

| Contract                     | Required for Otto                                                                                    | Current confidence                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Non-interactive prompt input | Prompt can be passed from Otto's `.otto-tmp/.run-*.md` file, stdin, or a documented exec subcommand. | Unknown / likely blocked by visible args        |
| Deterministic completion     | Child exits after the task, without requiring manual input.                                          | Unknown                                         |
| Parseable output             | Final text, error status, and optional usage can map to `StageResult`.                               | Unknown                                         |
| Rate/session limit mapping   | Freebuff queue/session/limit states can map to retry or `RateLimitError`.                            | Partially inferable from source, not CLI output |
| Sandbox story                | Either Freebuff owns a sandbox or Otto has an explicit host-only guard.                              | Unknown                                         |
| Auth/session preflight       | Missing credentials/session readiness can be reported before a paid or mutating run.                 | Partially inferable                             |
| Version probe                | `freebuff --version` reliably proves the installed launcher/native binary works.                     | Needs live check                                |

## Architecture

### Agent runtime ids

After the spike passes:

```ts
export type AgentRuntimeId = "claude" | "codex" | "freebuff";

export const AGENT_DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex CLI",
  freebuff: "Freebuff CLI",
};
```

Update every parser, config, help, and doc-contract test that currently expects `claude|codex`.

### Runtime adapter

Add `freebuffRuntime` in `packages/core/src/runner.ts`:

```ts
export const freebuffRuntime: AgentRuntime = {
  id: "freebuff",
  displayName: AGENT_DISPLAY_NAMES.freebuff,
  command: "freebuff",
  supportsSandboxSettings: false,
  buildArgs: buildFreebuffArgs,
  parseResultEvent: parseFreebuffResultEvent,
  createStreamParser: createFreebuffStreamParser,
  resetsAtFromEvent: resetsAtFromFreebuffEvent,
  buildEnv: buildFreebuffEnv,
};
```

The exact `buildFreebuffArgs` shape is spike-owned. Preferred upstream contract:

```text
freebuff exec --json --cwd <workspace> <prompt>
```

Acceptable alternatives:

- `freebuff --cwd <workspace> --json <prompt>`
- `freebuff --cwd <workspace> --prompt-file <path> --json`
- stdin prompt with JSONL output and deterministic process exit

Rejected for production:

- Writing keystrokes to the TUI.
- Scraping alternate-screen terminal output.
- Leaving the child alive after stage completion.

### Stage result mapping

`StageResult` fields for Freebuff:

- `result`: final assistant response or synthesized completion summary.
- `costUsd`: `0` unless Freebuff exposes a real paid-cost value.
- `usage`: token counts only if exposed; otherwise `emptyTokenUsage()`.
- `isError`: true for terminal error/limit states that are not normal completion.
- `apiErrorStatus`: concise original error message or session state.
- `runtimeId`: `"freebuff"`.

If Freebuff exposes session states but no reset time:

- `rate_limited`, quota, too-many-sessions -> `RateLimitError(message, null)`.
- `queued` is not a stage result. Either the CLI waits before executing, or preflight fails headless readiness.
- `country_blocked`, `banned`, `takeover_prompt`, `model_unavailable` -> fatal preflight/runtime errors unless the CLI can resolve them unattended.

### Preflight

Extend `runPreflight` with a Freebuff branch:

- Probe `resolveBin("freebuff")`.
- Probe `freebuff --version`, not just PATH, to catch launcher/binary mismatch.
- Probe credentials/session readiness from the verified source:
  - likely `~/.config/manicode/credentials.json`, or
  - `CODEBUFF_API_KEY`, or
  - a Freebuff-specific no-auth bootstrap if the binary proves one exists.
- If headless support is unavailable, the CLI row should be `ok: false` with a remediation that Freebuff currently needs interactive setup or upstream headless support.

`--print-config --agent freebuff` must show Freebuff rows and hide Claude/Codex rows.

### Sandbox policy

Freebuff can run terminal commands. Production support must not weaken Otto's default safety posture.

Rules:

- If Freebuff has a native sandbox flag, map `OTTO_RUNNER=sandbox` to it.
- If Freebuff has no sandbox, `--agent freebuff` with default `OTTO_RUNNER=sandbox` must fail closed with a clear message.
- Host mode may be allowed only when the operator explicitly sets `OTTO_RUNNER=host`.
- Do not claim parity with Claude's `--settings` sandbox or Codex's `--sandbox workspace-write` unless verified.

### Config surface

Once production support exists:

| Surface                                    | Change                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `--agent <runtime>`                        | Accept `freebuff`                                              |
| `OTTO_AGENT` / `.otto/config.json "agent"` | Accept `freebuff`                                              |
| `--fallback-agent <runtime>`               | Accept `freebuff`                                              |
| `OTTO_FALLBACK_AGENT` / config             | Accept `freebuff`                                              |
| `OTTO_FREEBUFF_MODEL`                      | Optional only if Freebuff exposes model selection              |
| `--print-config`                           | Show Freebuff runtime, preflight, model/session mode, fallback |

Do not add `OTTO_FREEBUFF_MODEL` until the CLI exposes a non-interactive model-selection contract. Freebuff's public product differentiates full and limited modes; Otto should not invent a model contract.

### Docs

Update these docs after a production adapter lands:

- `README.md`: runtime examples and prerequisites.
- `docs/CLI.md`: `--agent` accepted values and Freebuff status.
- `docs/CONFIG.md`: env vars, credentials/session, preflight.
- `SECURITY.md`: Freebuff command execution, data flow, sandbox status.
- `docs/ARCHITECTURE.md`: adapter details and output mapping.
- `docs/spikes/freebuff-runtime-spike.md`: final spike findings.

Before a production adapter lands, docs should describe Freebuff as "spike-gated" or "not yet executable via Otto", not as supported.

## Implementation Notes

### Spike harness

Create `scripts/freebuff-spike.mjs` and `scripts/freebuff-spike.test.mjs`, mirroring the Codex spike:

- `freebuffPreflight(probes)`
- `buildFreebuffArgs(promptRelPath, opts)`
- `parseFreebuffEvents(eventsOrLines)`
- `detectFreebuffLimit(eventsOrLines)`
- live smoke entrypoint

The spike tests should not require the real binary. They pin parser behavior from captured fixtures after a live smoke is available.

### Freebuff vs Codebuff

Do not implement Freebuff by silently spawning `codebuff`.

Reason: Codebuff mode accepts `[prompt...]`, but Freebuff mode has a different product promise, model/session behavior, and CLI surface. A Codebuff runtime can be a separate future initiative (`--agent codebuff`) if desired. This PRD is specifically Freebuff.

### Version gating

If a future Freebuff release adds `exec --json`, gate parser assumptions by version or fixture name. The package is moving quickly; a brittle parser without versioned fixtures will regress.

## Testing

Add or update:

- `agent-runtime.test.ts`: parse/resolve `freebuff`, invalid values list all ids.
- `cli-help.test.ts`: flags/env/config show Freebuff and preflight rows.
- `preflight.test.ts`: binary present, version fails, credentials present/missing, headless unsupported.
- `runner.test.ts`: `getAgentRuntime("freebuff")`, argv shape, no Claude/Codex flags, parser success/error/limit cases, `runtimeId`.
- `loop.test.ts`: fallback switch to/from Freebuff with mocked adapter once available.
- `agent-runtime-doc-contract.test.mjs`: docs list all runtime ids.
- `scripts/freebuff-spike.test.mjs`: spike parser/preflight fixtures.

Verification gate:

```bash
pnpm -r typecheck
pnpm -r test
pnpm test
```

Live smoke gate, only after a headless contract exists:

```bash
otto-afk --agent freebuff --print-config
otto-afk --agent freebuff "./docs/plans/<small-plan>.md" 1
```

## Acceptance Criteria

- Default `otto-afk` behavior is unchanged.
- `--agent freebuff` is unavailable or clearly marked blocked until the spike passes.
- Once available, Freebuff runs `otto-afk`, `otto-ghafk`, and `otto-linear-afk` stages without manual input.
- Freebuff logs, run records, and summaries include `runtimeId: "freebuff"`.
- `--fallback-agent freebuff --auto-switch-on-limit` never switches into an unavailable/interactive-only runtime.
- Docs accurately describe Freebuff's current state and setup.

## Non-goals

- TUI automation.
- Codebuff paid runtime support.
- Generic external-runtime plugin architecture.
- Provider-neutral token pricing for Freebuff.
- Freebuff model routing before the CLI exposes a stable model contract.
