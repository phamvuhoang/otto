# Freebuff CLI adapter spike (Phase 0)

**Status:** spike complete · conclusion: **`requires-upstream`** · no production
`--agent freebuff` support ships from this phase. The live smoke could not run on
this host (no `freebuff` binary present), and public Codebuff source confirms
Freebuff mode's arg parser intentionally does not accept initial prompt args.
The spike harness lives in `scripts/freebuff-spike.{mjs,test.mjs}` as a
non-shipping reference; the unit tests run without any binary.

**Goal:** confirm whether the Freebuff CLI (`freebuff`) can satisfy Otto's
non-interactive loop contract, and map each Claude-specific runner seam to its
Freebuff equivalent — or identify what upstream CLI change is needed before that
mapping can exist.

## How to reproduce the spike

```bash
node --test scripts/freebuff-spike.test.mjs        # candidate parser/preflight/argv (always runs, no binary)
node scripts/freebuff-spike.mjs "Reply: ok"        # live smoke — needs a working freebuff binary on PATH
```

The harness lives in `scripts/` (not `packages/core/src/`) and ships in no
tarball. It exports four symbols:

- `freebuffPreflight(probes)` — three-check preflight: CLI on PATH, version
  probe (catches launcher/native-binary mismatch), credential/session readiness.
  All probes are injectable so the unit tests run without spawning anything.
- `buildFreebuffArgs(promptRelPath, opts)` — candidate argv builder for a
  hypothetical `freebuff exec --json --cwd <workspace> <prompt>` headless
  contract (UNVERIFIED).
- `parseFreebuffEvents(eventsOrLines)` — maps a hypothetical JSONL event stream
  to Otto's `StageResult` shape (UNVERIFIED event schema).
- `detectFreebuffLimit(eventsOrLines)` — classifies Freebuff session states
  (`rate_limited`, `queued`, `country_blocked`, `banned`, `takeover_prompt`,
  `model_unavailable`) into `rate-limit`, `headless-not-ready`, or `fatal`
  (inferred from Codebuff source, UNVERIFIED as CLI output).

The production adapter would live in `packages/core/src/runner.ts` and
`packages/core/src/preflight.ts`. Schemas flagged **UNVERIFIED** need a live
binary to confirm.

## Live-smoke blocker (this host)

`freebuff` is **not installed** on this host. `npm install -g freebuff` has not
been run; `freebuff` is not on PATH; `freebuff --version` cannot be invoked.

Beyond the missing binary, public Codebuff source (the repository that publishes
`freebuff`) shows that Freebuff mode's argument parser exposes only:

- `--continue` — resume the last session
- `--cwd` — set working directory
- `login` — authenticate interactively
- `help` / version flags

It **intentionally does not accept initial prompt arguments**. Codebuff (paid)
mode accepts `[prompt...]`; Freebuff does not. This means even on a host where
the binary is installed, passing a prompt via argv in the current release is
expected to fail.

The live smoke gate therefore remains open pending both:

1. A host where `freebuff --version` succeeds.
2. A Freebuff release (or undocumented mode) that accepts a non-interactive
   prompt path — or an upstream feature request to add `freebuff exec --json`.

Note the failure mode for preflight: because an npm shim might be present on
PATH while the vendored native binary is absent (the same pattern seen with the
Codex adapter in `codex-runtime-spike.md`), a robust preflight must treat
"`freebuff --version` exits non-zero" as not-usable, not just "binary on PATH".
`freebuffPreflight` handles this via the injectable `runVersion` probe.

## Seam map: Claude runner → Freebuff equivalent

| Otto seam (Claude today)              | Freebuff equivalent                                                                                                                                        | Confidence                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `claude --print` (non-interactive)    | **None confirmed.** Freebuff mode's arg parser does not accept prompt args. Preferred upstream contract: `freebuff exec --json --cwd <workspace> <prompt>` | **BLOCKED** — no headless prompt path in current release                  |
| `--output-format stream-json`         | `freebuff exec --json` (hypothetical JSONL event stream)                                                                                                   | UNVERIFIED — hypothetical only                                            |
| `--permission-mode bypassPermissions` | No 1:1 — Freebuff has no known non-interactive approval/sandbox flag                                                                                       | UNVERIFIED                                                                |
| `--settings <file>` native sandbox    | Freebuff has no known sandbox flag; `supportsSandboxSettings: false` assumed                                                                               | UNVERIFIED — no sandbox surface confirmed                                 |
| `--model <spec>` (`OTTO_MODEL`)       | No confirmed model-selection flag for Freebuff mode                                                                                                        | UNVERIFIED — product is free/ad-supported with no documented model choice |
| `cwd = workspaceDir` on spawn         | `--cwd <dir>` is a confirmed Freebuff arg                                                                                                                  | documented                                                                |
| result event `total_cost_usd`         | **None** — Freebuff is free/ad-supported; no cost field expected                                                                                           | expected gap                                                              |
| result event `result` text            | `task.completed.output` (hypothetical, modeled on Codex spike)                                                                                             | UNVERIFIED                                                                |
| `usage.{input,output,cache_*}_tokens` | Unknown — Freebuff not known to expose token counts                                                                                                        | UNVERIFIED                                                                |
| `rate_limit_event` + 429 result       | `session.status.rate_limited` / `session.error` (inferred from Codebuff source)                                                                            | UNVERIFIED as CLI output                                                  |
| `~/.claude.json` / `~/.claude` auth   | `~/.config/manicode/credentials.json` or `CODEBUFF_API_KEY` (verified from Codebuff/Freebuff source)                                                       | documented                                                                |
| preflight: binary on PATH + auth file | `freebuff --version` succeeds + credentials.json or CODEBUFF_API_KEY                                                                                       | implemented in harness; live check needed                                 |

## Candidate StageResult mapping

`parseFreebuffEvents()` maps a hypothetical `freebuff exec --json` event stream
to Otto's `StageResult` (`{ result, costUsd, isError, apiErrorStatus, usage, runtimeId }`).
All event shapes are UNVERIFIED — modeled on what a headless Freebuff mode might
emit if one existed:

- **result** ← `output` field of the last `{ type: "task.completed" }` event.
- **usage** ← `emptyTokenUsage()` always. Freebuff is free/ad-supported and
  not known to expose token counts.
- **costUsd** ← `0` always. Freebuff reports no USD cost.
- **isError / apiErrorStatus** ← set from `session.error` events or terminal
  `session.status` values (`rate_limited`, `country_blocked`, `banned`,
  `takeover_prompt`, `model_unavailable`).
- **runtimeId** ← `"freebuff"`.

`detectFreebuffLimit()` classifies session states:

- `rate_limited` → `{ kind: "rate-limit", resetsAt: null }` — retryable, but
  Freebuff does not surface a reset time (documented gap; falls back to `null`,
  which the retry path already tolerates).
- `queued` → `{ kind: "headless-not-ready" }` — session not yet executing;
  headless automation cannot safely wait for an interactive queue.
- `country_blocked`, `banned`, `takeover_prompt`, `model_unavailable` →
  `{ kind: "fatal" }` — cannot proceed unattended.
- `session.error` messages matching `/rate.?limit|quota|too.?many.?session/i`
  → `{ kind: "rate-limit", resetsAt: null }`.

## Answers to the Open Questions (PRD §10)

**Does the distributed `freebuff` binary have an undocumented headless mode?**
Unknown — not confirmed against a live binary. Public Codebuff source shows
Freebuff mode's arg parser exposes only `--continue`, `--cwd`, `login`, help,
and version. No `exec` subcommand or `--json` flag is visible. An undocumented
mode may exist but cannot be confirmed here.

**Can Freebuff accept a prompt via stdin and then exit after completion?**
Unknown — needs a live binary. The current public CLI surface gives no evidence
of stdin prompt acceptance. This is the most likely viable path if Freebuff adds
headless support. Until confirmed, assume no.

**Does Freebuff expose JSONL, logs, or an SDK event stream?**
Unknown — the interactive TUI mode does not emit JSONL to stdout. Whether a
hidden or future `--json` flag exists cannot be determined without a binary.
The spike harness models a hypothetical JSONL event schema for when this
question resolves.

**What exact credential/session source should preflight check?**
Partially answered from Codebuff/Freebuff source: `~/.config/manicode/credentials.json`
(stored login session) and `CODEBUFF_API_KEY` (API key override). The harness
`freebuffPreflight` checks both. Whether a no-auth Freebuff bootstrap path
exists for the free tier is unconfirmed.

**Can Freebuff run with a command/write sandbox suitable for `OTTO_RUNNER=sandbox`?**
Unknown — no native sandbox flag is known for Freebuff mode. Until confirmed,
`--agent freebuff` with `OTTO_RUNNER=sandbox` must fail closed. The spec
architecture (`supportsSandboxSettings: false`) is the correct default.

**How should Otto represent Freebuff limits?**
The harness models the full classification based on inferred Codebuff session
states: `rate_limited` → rate-limit retry (no reset time); `queued` →
headless-not-ready; `country_blocked`, `banned`, `takeover_prompt`,
`model_unavailable` → fatal preflight/runtime errors. This mapping is UNVERIFIED
as actual CLI output; it matches the Codebuff source session enum.

## Remaining gaps

1. **No headless prompt path** — Freebuff mode's arg parser does not accept
   initial prompt args in the current release. Either an undocumented path
   exists (needs live binary) or Freebuff must add `exec --json` upstream.
2. **JSONL output unconfirmed** — interactive TUI does not emit JSONL; no
   `--json` flag in known CLI surface.
3. **Sandbox story absent** — no known sandbox or approval flag; cannot satisfy
   `OTTO_RUNNER=sandbox` without a product decision to run host-only.
4. **Session states unverified as CLI output** — the limit/session classification
   in the harness is inferred from Codebuff source, not captured from a real run.
5. **Reset time gap** — Freebuff does not surface a rate-limit reset time;
   `resetsAt` is always `null`, and the retry path must tolerate that.
6. **Version-probe completeness** — `freebuff --version` behavior with a missing
   native binary (the known npm platform-binary failure mode) is untested on a
   host that actually has the shim installed.
7. **Cost derivation** — Freebuff is free/ad-supported; `costUsd: 0` is the
   correct default and should not need a pricing table.

## Conclusion

**`requires-upstream`**

The live-smoke gate cannot be cleared on this host: the `freebuff` binary is not
installed, and public Codebuff source confirms Freebuff mode intentionally omits
initial prompt argument support. No non-interactive prompt path is provable from
either local binary access or public documentation.

Otto needs an upstream Freebuff headless contract — preferred:
`freebuff exec --json --cwd <workspace> <prompt>` — before Phases 1–6 can
proceed. Until that contract exists:

- No production `--agent freebuff` support ships from this phase.
- The live-smoke gate remains open pending a host with a working `freebuff`
  binary and a confirmed non-interactive prompt path.
- The spike harness (`scripts/freebuff-spike.{mjs,test.mjs}`) stays as a
  reference and test bed; update it when the headless contract is verified.

If Freebuff adds headless support in a future release, re-run the live smoke
(`node scripts/freebuff-spike.mjs "Reply: ok"`), verify event shapes against the
UNVERIFIED fixtures in `freebuff-spike.test.mjs`, and promote to Phase 1.
