# issue-24 — Otto Agent Runtime

## Problem

Otto hardcodes `claude` as the agent CLI throughout the runner. Issue #24 is a
P0–P5 roadmap to (a) introduce a provider-neutral `AgentRuntime` boundary, (b)
make the selected runtime visible everywhere, (c) prove a Codex CLI adapter, (d)
ship stable Codex support, (e) auto-switch on rate limits, and (f) update docs.
The product requirement: a user must always know **which** runtime is active,
**why** it was selected, and **whether** Otto switched mid-run.

## Approach

Build in the issue's recommended order, smallest behavior-preserving slice
first. Claude stays the default and its behavior is unchanged at every step
until a real Codex adapter exists.

This run implements **only build-order step 1**: agent-runtime config parsing
and resolution, surfaced in `--print-config`. The actual runner still spawns
`claude`; selecting an unimplemented runtime for a *real* run fails cleanly
rather than silently running Claude (so the "user always knows the runtime"
contract holds even before the Codex adapter lands).

### This run's slice (P0/P1 foundation)

- New pure module `agent-runtime.ts`:
  - `AgentRuntimeId = "claude" | "codex"`, `DEFAULT_AGENT = "claude"`.
  - `AGENT_DISPLAY_NAMES` (`claude` → "Claude Code", `codex` → "Codex CLI").
  - `AgentSelectionSource = "default" | "flag" | "env" | "config"`.
  - `parseAgentId(raw, label)` — validate a raw id, throw a clean one-line error.
  - `resolveAgentRuntime({ flag, env, config })` — precedence
    flag → env → config → default; returns `{ id, displayName, source }`.
  - `readAgentConfig(workspaceDir)` — read the `agent` field from
    `.otto/config.json` (absent/malformed → undefined; never throws).
- `--agent <claude|codex>` flag in `parseFlags` (validated via `parseAgentId`).
- `run-bin` resolves the runtime (flag/env/config), mirroring the `OTTO_TOKEN_MODE`
  pattern: an invalid `OTTO_AGENT`/config value is reported by `--print-config`
  without a stack trace and is fatal (exit 1) on a real run.
- `--print-config` shows the active runtime, its display name, and the selection
  source.
- A real run with a resolved runtime other than `claude` exits 1 with a clear
  "not implemented yet" message (Codex adapter is a later task). `--print-config`
  still reports the selection (read-only diagnostic, no guard).

## Assumptions

- **Q: How much of the P0–P5 roadmap in one run?** → Only build-order step 1
  (config parsing + visibility). Rationale: the issue itself prescribes this
  order and each later step (adapter extraction, Codex spike, fallback) is its
  own medium-sized slice; the workflow mandates ONE task per run.
- **Q: Should `--agent codex` work end-to-end now?** → No. Codex adapter is P2/P3.
  Accept `codex` as a valid *id* (so selection is visible) but fail a real run
  cleanly until the adapter exists. Rationale: preserves the product's
  "always know the runtime" contract without silently running Claude.
- **Q: How to validate `OTTO_AGENT` / config values?** → Mirror `OTTO_TOKEN_MODE`:
  flag invalid → throw in parseFlags; env/config invalid → reported by
  `--print-config`, fatal on real run. Rationale: established repo pattern.
- **Q: Where does config live?** → `.otto/config.json` `agent` field, read with a
  dedicated `readAgentConfig` (mirrors `readBranchConfig`). Rationale: decoupled
  from branch config, same never-throw shape.
- **Q: Provider-specific model env (`OTTO_CLAUDE_MODEL`/`OTTO_CODEX_MODEL`)?** →
  Deferred to P3. This run keeps the existing single `OTTO_MODEL` line.

## Testing notes

- `agent-runtime.test.ts`: `parseAgentId` (valid/invalid), `resolveAgentRuntime`
  precedence (flag > env > config > default) + source labels, `readAgentConfig`
  (present/absent/malformed/non-string).
- `cli-help.test.ts`: `parseFlags --agent` (valid, invalid throws, missing value
  throws) + `--print-config` runtime + source lines.
- `run-bin.test.ts`: invalid `OTTO_AGENT` reported under `--print-config` (exit 0)
  / fatal on real run; `--agent codex` real run fails "not implemented".
- `pnpm -r typecheck && pnpm -r test && pnpm test` green.
