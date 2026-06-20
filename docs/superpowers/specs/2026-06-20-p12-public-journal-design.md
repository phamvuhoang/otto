# Design: Otto's public journal — build-in-public on SNS (P12)

Date: 2026-06-20
Status: Approved (brainstorm), pending spec review → implementation plan
Issue: #67 (P12) · Epic: #68 (Phase 2)
Depends on (all shipped): P4 safety/taint substrate (`safety-policy.ts`, `taint.ts`), P3 governed memory (`memory.ts`), the Linear-API HTTP/credential pattern (`linear-api.ts`).

## Summary

During a run, Otto turns a generic craft learning into a short "field note" and — through an **airtight, default-deny secrecy gate** — either drafts it to disk (default) or publishes it to Threads (autonomous opt-in only). The whole feature is **off by default** and a no-op unless a repo opts in via `.otto/config.json`.

The single non-negotiable invariant is **zero leak**: *a post that cannot be proven safe is never sent.* Everything below is built around that.

Decisions locked in brainstorm:

- **Full live Threads pipeline** this cycle (real Threads Graph API), but gated behind a double opt-in; default mode never posts.
- **Layered defense-in-depth secrecy gate, all gates must pass, default-deny** — any gate failing *or throwing* blocks the post.
- **Fully in-loop**: generation + screening + (autonomous) posting run from the harness at run end. **No separate CLI.** In default mode Otto only *drafts to disk*; a human picks the draft up. Otto posts only under the autonomous opt-in.
- **Memory-first source**: entries derive from P3 governed-memory records (already generalized, scoped, categorized), not from diffs or the work log.

## Grounding: what exists today

From the codebase map (verified against `main`):

- **`SafetyPolicy`** (`safety-policy.ts`) has a `secretPatterns: string[]` field that is currently **read but never evaluated** — P12 finally wires it. Plus `readSafetyPolicy(workspaceDir)` (absent/malformed `.otto/policy.json` → permissive `DEFAULT_POLICY`). Check functions return `PolicyViolation[]`.
- **Taint** (`taint.ts`): `TAINT_SOURCES`, `wrapUntrusted`, `UNTRUSTED_WARNING` — a defensive substrate, inert today.
- **`MemoryRecord`** (`memory.ts`): `{ id, content, category?, sourceRun?, taskKey?, scope[], confidence, trust, status, createdAt, useCount, … }`. `readMemoryRecords(workspaceDir)` reads `.otto/memory/*.json`; `memoryStatus(rec, now)` derives active/stale/superseded. Categories mirror `LEARNINGS.md`: convention / gotcha / decision / dead-end.
- **HTTP/credential pattern** (`linear-api.ts`): injectable `fetch`, `createLinearClient(deps)`, `resolveLinearAuth(deps)` reading `OTTO_*` env then `~/.config/otto/<svc>.json`; `LinearApiError` with a `kind`. This is the template for `threads-api.ts`.
- **Stages** (`stages.ts` / `stage-exec.ts`): a stage is `{ name, template, permissionMode?, tier? }`; `executeStage(opts)` renders a template + runs it via the sandboxed agent and returns a `StageResult`. The agent is sandboxed; the **harness process** (`loop.ts`) has full network and does the actual posting.
- **Config**: `.otto/config.json` read ad hoc (e.g. `readAgentConfig`); the loop runs from `run-bin.ts` → `runLoop`.
- **No redaction utility exists** — P12 builds it.

## Architecture & data flow

A **run-end journal hook** runs once, after the loop's stage walk completes, inside `runLoop` (harness process). It is a complete no-op unless the repo opts in. Pipeline:

```
select(memory)  →  generate(agent)  →  GATE 1 deny-list  →  GATE 2 generalization  →  GATE 3 judge(agent)
   pure            stage (text)          pure                  pure                       stage (verdict)
                                          │ all must pass, default-deny │
                                          ▼
                              default:  write draft → .otto/journal/drafts/<id>.md   (never posts)
                              autonomous (double opt-in): POST to Threads, record in posted ledger
                                          ▼
                              audit every decision → .otto/journal/audit.log
```

**Privilege separation (key safety property):** the agent only ever *produces text* (the field note, and the judge verdict) inside the sandbox. The **harness** owns the deterministic gates, the audit trail, the dedup/cadence ledger, and the network egress. A compromised/over-eager agent cannot post — it cannot reach the gate's decision or the HTTP client.

## The secrecy gate (`journal-gate.ts`) — the hard gate

Three independent gates; **`screenEntry(entry, ctx): GateResult` runs them in order and denies on the first failure, on an empty/over-long entry, or on any thrown error** (default-deny). `GateResult = { ok: true } | { ok: false; gate: 1|2|3; reason: string }`.

**Gate 1 — deterministic deny-list** (pure; the backbone). Reject if the note matches any of:

- **Secrets/credentials**: high-entropy tokens, `sk-`/`ghp_`/`gho_`/`xox`-style keys, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `password=`/`token=`/`secret=`/`api[_-]?key` assignments, `Bearer <token>`.
- **Every pattern in `SafetyPolicy.secretPatterns`** (from `.otto/policy.json`) — compiled with `new RegExp(p, "i")`, each in a try/catch so a bad pattern → deny (not crash).
- **Identifiers**: URLs (`https?://…`), filesystem paths (`/…/…`, `./…`, `C:\…`), code fences (```` ``` ````) and inline `` `code` `` spans, `@scope/pkg` and bare `import`/`require(...)` statements.
- **Repo self-identifiers** (passed in `ctx`): the repo name, git remote URL/host/owner, the workspace dir basename, and a sample of tracked top-level file/dir names — so the note can't name *this* project.

**Gate 2 — generalization check** (pure). The note must read as generic craft. Reject if it contains: task-key shapes (`issue-\d+`, `[A-Z]{2,}-\d+`), any of the source record's `scope` globs or `taskKey`, a `sourceRun` id, or (heuristic) more than N capitalized multi-word proper-noun phrases (likely product/company names). Enforce length bounds (Threads ≤ 500 chars; also a sane minimum).

**Gate 3 — adversarial judge** (agent stage, biased to refuse). Template `journal-screen.md`: a read-only prompt that gives the candidate note and asks *"Could any reader identify the specific repository, product, company, person, or any private/internal detail from this? Could it embarrass the project? If there is ANY doubt, answer UNSAFE."* The stage must emit `<journal-verdict>SAFE</journal-verdict>` exactly; **anything else — UNSAFE, malformed, empty, or a stage error — denies.**

**Audit trail:** every `screenEntry` call appends one JSON line to `.otto/journal/audit.log` — timestamp, candidate (the *screened* text, which by construction passed Gate 1+2 if it reached the log; denied-at-Gate-1 entries are logged with the matched pattern name, never the raw secret), decision, gate, reason. This makes any near-miss forensically reviewable without itself leaking.

## Generation source & agent stages

- **Selection** (`journal-source.ts`, pure): `readMemoryRecords` → keep `status==="active"` records in journal-worthy categories (config `categories`, default `gotcha` + `dead-end`), rank by confidence × freshness, exclude any whose id is in the posted ledger, return the top candidate (or none).
- **Generation stage** `journal-write.md` (`tier: strong`, read-only, `bypassPermissions`): given the selected learning's `content`, rewrite it as one short first-person "field note" in the persona *a coding agent's field notes* — a general craft lesson with **no project, file, tool-version, or task specifics**. Output the note text only.
- Both new stages are added to `STAGES` and ship in the tarball (templates).

## Threads publishing (`threads-api.ts`) & modes

Mirrors `linear-api.ts`:

- `resolveThreadsAuth(deps)`: `OTTO_THREADS_TOKEN` + `OTTO_THREADS_USER_ID`, else `~/.config/otto/threads.json` (`{ token, userId }`). Returns `null` when unset → posting impossible (gate result is moot; nothing is sent).
- `createThreadsClient({ token, userId, fetch?, baseUrl? })` → `{ publish(text): Promise<{ id }> }`. Real Threads Graph API two-step: `POST {base}/{userId}/threads?media_type=TEXT&text=…&access_token=…` → `creation_id`; then `POST {base}/{userId}/threads_publish?creation_id=…&access_token=…` → post id. `ThreadsApiError { kind: "auth"|"network"|"api" }`. `fetch` injected for tests.

**Modes:**
- **`draft` (default):** write the screened note to `.otto/journal/drafts/<id>.md` with its audit metadata. **Never posts.**
- **`autonomous` (double opt-in — requires BOTH `journal.autonomous: true` in config AND `OTTO_JOURNAL_AUTONOMOUS=1`):** if every gate passed, `publish()` the note, then record it in the posted ledger. Missing/invalid creds → log and stop (no throw).

## Cadence & dedup (`journal-ledger.ts`)

- **At most one post per run.**
- **Posted ledger** `.otto/journal/posted.json`: `[{ memoryId, contentHash, postedAt, postId? }]`. Skip a candidate whose `memoryId` or `contentHash` is already present, or if the newest post is younger than `journal.minDaysBetweenPosts` (default 1). Drafts also record to a `drafted` set to avoid re-drafting the same memory every run.
- The ledger lives under `.otto/journal/` (git-ignored alongside `.otto/runs/`).

## Config / opt-in (`journal-config.ts`)

`.otto/config.json`:
```json
{ "journal": {
    "enabled": false,
    "autonomous": false,
    "platform": "threads",
    "categories": ["gotcha", "dead-end"],
    "minDaysBetweenPosts": 1
} }
```
`readJournalConfig(workspaceDir)` → normalized config or `undefined`. **Absent or `enabled:false` ⇒ the run-end hook returns immediately — zero behavior change, zero network, zero stages.** Network egress for posting happens only with `enabled:true` **and** the autonomous double opt-in.

## Loop wiring

In `runLoop`, after the stage walk and before the `finally`/summary, call `await maybeJournal({...})` from `journal.ts`. It: reads config (no-op if disabled) → selects a candidate (return if none) → runs the generation stage → `screenEntry` (3 gates) → drafts, and in autonomous mode posts. All wrapped so **any error is caught, audited, and swallowed** — the journal must never fail or slow a run, and on doubt it does nothing. Cost of the two stages rolls into the run total via the existing accounter.

## New surface (summary)

| Config / env                          | Effect                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `.otto/config.json` `journal.enabled` | Master switch (default false ⇒ full no-op).                            |
| `journal.autonomous` + `OTTO_JOURNAL_AUTONOMOUS=1` | Double opt-in required to actually post (else draft-only). |
| `journal.categories` / `minDaysBetweenPosts` | Which memory categories qualify; cadence floor.                 |
| `OTTO_THREADS_TOKEN` / `OTTO_THREADS_USER_ID` | Threads credentials (or `~/.config/otto/threads.json`).        |
| `SafetyPolicy.secretPatterns` (`.otto/policy.json`) | Extra repo-defined deny-list patterns for Gate 1.         |

## Sequencing (7 slices, one spec)

1. **`journal-gate.ts` Gate 1** — deterministic deny-list (built-in patterns + `secretPatterns` wiring + repo self-identifiers) + the `.otto/journal/audit.log` append. Pure, exhaustively tested (positive *and* negative cases per pattern family).
2. **Gate 2** — generalization check (task-keys, scope/taskKey/run leakage, length bounds, proper-noun heuristic). Pure. Plus the `screenEntry` orchestrator (Gates 1+2, default-deny; Gate 3 stub returns "needs judge").
3. **`threads-api.ts`** — `resolveThreadsAuth` + `createThreadsClient` + two-step publish + `ThreadsApiError`, injectable `fetch`. Unit-tested with a fake fetch (no real network).
4. **`journal-source.ts` + `journal-ledger.ts`** — candidate selection from memory; posted/drafted ledger; dedup + cadence. Pure.
5. **Agent stages** — `journal-write.md` (generate) + `journal-screen.md` (judge) added to `STAGES`; Gate 3 wired into `screenEntry` (verdict parse, default-deny on anything but exact `SAFE`).
6. **`journal.ts` orchestrator** — `maybeJournal` tying select → generate → screen → draft/post, error-swallowing + audit, draft-default / autonomous-double-opt-in. Injectable stage-runner + Threads client + clock for tests.
7. **Loop wiring + config reader + docs** — `readJournalConfig`, call `maybeJournal` at run end, README + ARCHITECTURE sections, example `.otto/config.json` journal block. Off-by-default verified.

## Testing

- `journal-gate.test.ts`: each Gate-1 family — a leaking string is **denied**, a clean paraphrase **passes**; `secretPatterns` from policy denies; a malformed policy pattern denies (no throw); repo self-identifiers deny; audit line shape. Gate 2: task-keys / scope / run-id / over-length deny; generic craft passes.
- `threads-api.test.ts`: two-step publish issues create then publish with the right URLs/params (fake fetch); auth/network/api errors classified; missing creds → `resolveThreadsAuth` null.
- `journal-source.test.ts` / `journal-ledger.test.ts`: selection filters by category/status/ledger; dedup by id + content hash; cadence floor; "no candidate" path.
- `journal.test.ts`: full pipeline with injected stage-runner + fake Threads client + fixed clock — default mode drafts and never calls publish; autonomous (both opt-ins) posts only on all-gates-pass; **a Gate-3 UNSAFE verdict, a generation error, and a thrown gate all result in no post**; ledger updated only on a real post; disabled config → complete no-op.
- `loop.test.ts` (extend): journal hook is a no-op without config; runs (and only drafts) when enabled non-autonomous.
- Gate: `pnpm -r typecheck && pnpm -r test && pnpm test`.

## Success criteria

- Default run (no `journal` config): byte-for-byte today's behavior — no stages, no files, no network.
- With `journal.enabled` (non-autonomous): a run produces a screened draft under `.otto/journal/drafts/` and **never** posts; every leaking fixture is denied at Gate 1 or 2.
- With the autonomous double opt-in + a fake Threads client in tests: a gate-passing note posts exactly once and lands in the ledger; any single gate failing/throwing yields zero posts.
- The audit log records every decision; denied-at-Gate-1 entries never contain the raw matched secret.
- `typecheck` + all suites green.

## Non-goals (v1)

- Auto-follow / auto-reply / replies / threads-of-posts; cross-posting to any platform besides Threads; image/media/link-card posts.
- An interactive approval TUI or a journal CLI (the in-loop hook + on-disk drafts are the approval surface).
- Sourcing from raw diffs, commits, or the work log (memory-only keeps inputs pre-generalized).
- Auto-tuning categories/cadence from engagement metrics.

## Open questions (resolve in plan/impl)

1. Exact Threads Graph API base host/version (`graph.threads.net/v1.0`) and the `media_type=TEXT` field names — keep `baseUrl` injectable and the error `kind` coarse so a field rename surfaces as an `api` error, not a crash. Verified against current docs at build time.
2. The proper-noun heuristic in Gate 2 is necessarily fuzzy; it is **additive** to the deterministic Gate 1 and the Gate 3 judge, and biased to over-deny. If it proves noisy, tighten its threshold — it can only cause over-denial (safe), never under-denial.
3. Whether to also screen the *generation stage's* presence of the persona header — deferred; Gate 1/2/3 screen the content regardless of framing.
