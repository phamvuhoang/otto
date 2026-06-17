# Codex CLI adapter spike (issue #24, P2)

**Status:** spike complete · live smoke **BLOCKED on this host** (Codex native
binary missing — see below). Findings + a candidate parser/preflight/argv
builder are pinned by `scripts/codex-spike.{mjs,test.mjs}`; P3 promotes the
verified pieces into a real `codexRuntime` adapter.

**Goal:** confirm whether Codex CLI (`@openai/codex`) can satisfy Otto's
non-interactive loop contract, and map each Claude-specific runner seam to its
Codex equivalent **before** building the P3 adapter.

## How to reproduce the spike

```bash
node --test scripts/codex-spike.test.mjs        # candidate parser/preflight/argv (always runs)
node scripts/codex-spike.mjs "Reply: ok"        # live smoke — needs a working codex binary
```

The harness deliberately lives in `scripts/` (not `packages/core/src/`): the P0
learning keeps Codex-specific parsing out of the runner until its signal shape
is verified, and `scripts/` ships in no tarball. Schemas flagged **UNVERIFIED**
below still need a live-binary confirmation pass at the start of P3.

## Live-smoke blocker (this host)

`codex` resolves on PATH (`/opt/homebrew/bin/codex`, `@openai/codex` 0.104.0)
but every invocation fails:

```
Error: spawn .../@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT
```

The npm shim is present; its vendored native binary
(`node_modules/@openai/codex-darwin-arm64/.../codex`) is **not** — the `vendor`
dir is empty. So `codex --version`, `codex --help`, and the spike smoke all
fail. The contract below is therefore drawn from the Codex CLI's documented
`exec` interface and the 0.104.0 package, **not** from a captured live run on
this host. **P3 first task: install a working Codex, run the smoke, and diff the
real event stream against the UNVERIFIED fixtures here.**

Note the failure mode for preflight: because the _shim_ exists on PATH, a naive
`which codex` check reports the CLI as present — the breakage only surfaces on
spawn (non-zero exit + ENOENT on stderr, not a spawn `error` event). A robust
P3 preflight should treat "`codex --version` exits non-zero" as not-usable, not
just "binary on PATH".

## Seam map: Claude runner → Codex equivalent

| Otto seam (Claude today)                                          | Codex equivalent                                                                                                                  | Confidence                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `claude --print` (non-interactive)                                | `codex exec <prompt>` (alias `codex e`); prompt positional or via stdin                                                           | documented                                            |
| `--output-format stream-json`                                     | `codex exec --json` (JSONL event stream on stdout)                                                                                | UNVERIFIED event schema                               |
| `--permission-mode bypassPermissions`                             | no 1:1 — closest is `--sandbox <mode> --ask-for-approval never` (or `--full-auto` / `--dangerously-bypass-approvals-and-sandbox`) | documented                                            |
| `--settings <file>` native sandbox (writes confined to workspace) | Codex has its OWN sandbox: `--sandbox read-only\|workspace-write\|danger-full-access`; no Claude-style settings JSON              | documented; `supportsSandboxSettings:false` for codex |
| `--model <spec>` (`OTTO_MODEL`)                                   | `-m, --model <spec>`                                                                                                              | documented                                            |
| `cwd = workspaceDir` on spawn                                     | same, or `-C, --cd <dir>`                                                                                                         | documented                                            |
| result event `total_cost_usd`                                     | **none** — Codex emits token counts only; USD must be derived (tokens × pricing)                                                  | gap (P3)                                              |
| result event `result` text                                        | last `item.completed` agent_message `.text`                                                                                       | UNVERIFIED                                            |
| `usage.{input,output,cache_*}_tokens`                             | `turn.completed.usage.{input_tokens,cached_input_tokens,output_tokens}` (no cache-creation concept)                               | UNVERIFIED                                            |
| `rate_limit_event` + `is_error`/429 result                        | `turn.failed`/`error` event with a message; reset-time field shape unknown                                                        | UNVERIFIED                                            |
| `~/.claude.json` / `~/.claude` auth                               | `~/.codex/auth.json` (ChatGPT login) **or** `OPENAI_API_KEY`                                                                      | documented                                            |
| preflight: `claude` on PATH + auth file                           | `codex` on PATH + `~/.codex/auth.json`/`OPENAI_API_KEY`                                                                           | documented                                            |

## Candidate StageResult mapping

`parseCodexEvents()` maps a `codex exec --json` thread/item stream to Otto's
`StageResult` (`{ result, costUsd, isError, apiErrorStatus, usage, runtimeId }`):

- **result** ← text of the last `item.completed` whose `item.type ===
"agent_message"`.
- **usage** ← `turn.completed.usage`: `inputTokens`/`outputTokens` direct,
  `cacheReadInputTokens` ← `cached_input_tokens`, `cacheCreationInputTokens`
  always `0` (Codex has no cache-creation token class).
- **costUsd** ← `0`. **Gap:** Codex reports no USD; budget accounting
  (`accountStage`) currently sums `costUsd`, so a Codex run reports `$0.00`
  until P3 derives cost from tokens × a pricing table.
- **isError / apiErrorStatus** ← set from a `turn.failed`/`error` event; the
  message string is preserved so the existing `isLimitResult()` regex can
  classify rate limits without a Codex-specific branch.
- **runtimeId** ← `"codex"`.

`detectCodexRateLimit()` scans for a `turn.failed`/`error` message matching
`/rate.?limit|usage limit|quota|too many requests|429/i` and opportunistically
reads `error.resets_in_seconds`/`error.resets_at` for the reset time
(**UNVERIFIED** — Codex's real reset field is unknown until a live limit is
captured; falls back to `null`, which the retry path already tolerates).

## Answers to the spike questions

- **Non-interactive from a prompt file?** Yes — `codex exec` with the prompt as
  a positional arg (or stdin). Otto's existing "Read the full instructions from
  the file ./…" prompt string works unchanged via `buildCodexArgs()`.
- **Machine-readable stream?** Yes — `codex exec --json` emits JSONL. Schema is
  the thread/item event model (`thread.started` → `item.completed` →
  `turn.completed`), but the exact field names are UNVERIFIED here.
- **Result / errors / cost / rate-limit representation?** Result + tokens are in
  the event stream; **cost in USD is absent** (must be derived); rate-limit
  signal shape is unconfirmed.
- **Permissions / sandbox?** Codex owns sandboxing via `--sandbox` +
  `--ask-for-approval`; it does **not** accept Otto's `--settings` file, so the
  codex adapter sets `supportsSandboxSettings: false` and the runner must skip
  writing the transient settings JSON for it (the boundary already gates this).
- **Auth / preflight?** `~/.codex/auth.json` or `OPENAI_API_KEY`; detectable
  distinctly from Claude. Caveat: check `codex --version` succeeds, not just
  PATH presence (see blocker).
- **Same workspace + scratch model?** Yes — `cwd = workspaceDir`, prompt under
  `.otto-tmp/`, JSONL streamed to a log. No Codex-specific scratch needs found.

## Known gaps to close in P3

1. **Verify the `exec --json` event schema against a live binary** — the
   item/turn field names above are UNVERIFIED. This is the first P3 step.
2. **Cost in USD** — Codex emits no `total_cost_usd`; budget accounting needs a
   tokens×pricing derivation or it reports `$0.00`.
3. **Rate-limit reset field** — confirm where Codex exposes reset time so
   `RateLimitError.resetsAt` (and `computeWaitMs`) stay meaningful for Codex.
4. **Sandbox parity** — Codex's `--sandbox workspace-write` is its own
   confinement; confirm it confines writes to the workspace like Otto's native
   sandbox before treating `OTTO_RUNNER=sandbox` as satisfied for codex.
5. **Preflight robustness** — treat a shim-present/binary-broken Codex (this
   host) as unusable, not "found".
6. **Model env** — P3's `OTTO_CODEX_MODEL` maps to `-m/--model`; `OTTO_MODEL`
   stays the provider-neutral default.
