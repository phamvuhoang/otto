# Freebuff CLI adapter spike (Phase 0)

**Status:** spike complete · conclusion: **`requires-upstream`** (confirmed live
against `freebuff` v0.0.115 on 2026-06-26) · no production `--agent freebuff`
support ships from this phase. The live smoke **was run against the real binary**
and confirms what public Codebuff source predicted: Freebuff's CLI exposes only a
`login` subcommand and `--continue`/`--cwd` options — it rejects any prompt
argument and has no `exec`/`--json` headless path. The spike harness lives in
`scripts/freebuff-spike.{mjs,test.mjs}` as a non-shipping reference; the unit
tests run without any binary.

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
tarball. The live-smoke `main()` is guarded by an `import.meta.url` check, so
importing the module in the unit tests never spawns anything. It exports five
symbols:

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
- `finalizeFreebuffResult(parsed, { code, stderr })` — folds the child process
  exit code and stderr into the parsed result, so a non-zero exit with no stdout
  events surfaces as an error (added after the live smoke exposed that gap).

The production adapter would live in `packages/core/src/runner.ts` and
`packages/core/src/preflight.ts`. Schemas flagged **UNVERIFIED** need a live
binary to confirm.

## Live-smoke results (`freebuff` v0.0.115, 2026-06-26)

The binary was installed (`npm install -g freebuff`, v0.0.115) and probed on a
host that already had an authenticated session (`~/.config/manicode/credentials.json`).
All probes ran with stdin closed and a hard timeout so the interactive TUI could
not hang the session. Results:

| Probe                                           | Result                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freebuff --version`                            | **exit 0**, prints `0.0.115`. On first run the launcher lazily downloads a 33.1 MB native binary, then succeeds. (`npm` ran with `allow-scripts` off, so the `postinstall` was skipped; the launcher self-heals on first invocation.) |
| `freebuff --help`                               | Lists `Usage: freebuff [options] [command]`; the **only** command is `login`; options are `--continue [id]`, `--cwd <dir>`, `-v/--version`, `-h/--help`. No `exec`, no `--json`, no positional prompt.                                |
| `freebuff "say hello and exit"` (prompt as arg) | **exit 1** — `error: command-argument value '…' is invalid for argument 'command'. Allowed choices are login.`                                                                                                                        |
| `freebuff exec --json "…"` (preferred contract) | **exit 1** — `error: unknown option '--json'`. The hypothesized headless contract does not exist.                                                                                                                                     |
| bare `freebuff --cwd <dir>` (stdin closed)      | Drops into the interactive **TUI** (alternate-screen, "Connecting…" spinner) and **does not exit** — had to be SIGTERM'd at the timeout. With no prompt path it hangs in any headless context.                                        |
| `~/.config/manicode/credentials.json`           | Present; shape `{ default: { id, name, email, authToken, fingerprintId, fingerprintHash } }`. Confirms the auth-preflight source and that an `authToken` is the credential.                                                           |

Harness validation: `node scripts/freebuff-spike.mjs "print hello"` reported
preflight **cli: ok / version: ok (0.0.115) / auth: ok** — all three green — then
spawned `freebuff exec --json …`, which the real binary rejected (`exited 1`).
The live run also exposed a harness gap (now fixed): a non-zero exit with no
stdout events was returned as `isError: false`. `finalizeFreebuffResult()` now
folds the child exit code + stderr into the result, so the live failure surfaces
as `isError: true, apiErrorStatus: "error: unknown option '--json'"`.

**Conclusion of the live smoke: blocked, exactly as predicted.** The current
Freebuff release has no non-interactive prompt path; bare invocation hangs in a
TUI. This is hard evidence (not inference) that the gate cannot clear on v0.0.115.

The live smoke gate remains open pending a Freebuff release (or undocumented
mode) that accepts a non-interactive prompt and exits deterministically —
preferred upstream contract: `freebuff exec --json --cwd <workspace> <prompt>`.

Preflight note: an npm shim can be present on PATH while the native binary is
absent (the launcher downloads it lazily — observed live above), the same
pattern seen with the Codex adapter. A robust preflight must treat
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
**No (confirmed on v0.0.115).** `freebuff --help` lists only the `login`
command with `--continue`/`--cwd`/version/help options. A prompt argument is
rejected (`Allowed choices are login`), `--json` is an `unknown option`, and
bare invocation enters an interactive TUI. No headless mode is reachable through
any documented or guessed flag in this release.

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
6. **Version-probe behavior** — confirmed live: `freebuff --version` lazily
   downloads the native binary on first run then exits 0 with `0.0.115`. The
   missing-native-binary failure mode self-heals via download, so preflight must
   also tolerate the first-run download latency, not only a hard version failure.
7. **Cost derivation** — Freebuff is free/ad-supported; `costUsd: 0` is the
   correct default and should not need a pricing table.

## Conclusion

**`requires-upstream`** (confirmed live against v0.0.115)

The live smoke ran against the real binary and confirms the gate cannot clear:
`freebuff` v0.0.115 rejects any prompt argument, has no `exec`/`--json` headless
path, and hangs in an interactive TUI on bare invocation. Binary presence,
version, and authenticated credentials are all fine — the missing piece is purely
the non-interactive prompt contract, which the current release does not provide.

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
