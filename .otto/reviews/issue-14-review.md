# Code review — issue #14 (`otto/14`): "otto-linear-afk" Linear loop

Date: 2026-06-16 · Branch: `otto/14` vs `main` (PR #15) · Scope: `git diff main...otto/14` (~2.9k lines)

## Summary

The full `otto-linear-afk` feature (not just the docs commit the PR description
highlights): a Linear GraphQL client, a credential tool, a bundled `otto-linear`
helper CLI, two new stages + templates, watch-mode polling, and the run-bin/
preflight/cli-help wiring.

Overall **solid and well-structured** — it cleanly mirrors the GitHub provider
and follows the repo's conventions: parameterized GraphQL `variables` (no query
injection), refs constrained to a shell-safe `[A-Za-z0-9-]` charset before they
can reach `OTTO_ISSUE`, both HTTP status *and* the GraphQL `errors` array
checked, credentials resolved inside the subprocess (never interpolated into a
rendered prompt/spill/NDJSON), and injectable env/fs probes throughout.

Two finder claims were investigated and **refuted**: the preflight `linearAuth`
probe is lazy and gated on `bin === "otto-linear-afk"` (`preflight.ts:104`), not
eagerly run for every mode; and the `done` team-key `identifier.split("-")[0]`
(`linear-cli.ts:201`) is correct because Linear team keys never contain hyphens.

Findings below are edges and polish — none are merge blockers. #1–#3 are the
cheap, user-facing ones worth fixing first; #5 is the highest-value cleanup.

Commits in scope:

- `ea8bc4a` docs(linear): document otto-linear-afk mode + doc-contract test
- `9ab6cac` feat(linear): add otto-linear done + completion playbook
- `c050ebb` fix(review): match printConfig watch label to run-bin in Linear mode
- `898d572` feat(linear): add --watch poll mode for otto-linear-afk
- `21b4693` feat(linear): wire runLinearAfk + otto-linear-afk bin
- `d71d88f` feat(linear): add Linear AFK stages + templates
- `d98256c` fix(review): validate linear --limit before auth gate
- `0abd318` feat(linear): add bundled linear helper CLI (list/dump/view/comment)
- `7a1874c` fix(review): re-tighten linear.json perms to 0600 on re-login
- `ddc9565` feat(linear): add otto-linear-auth credential tool (login/status/logout)
- `2e0499d` fix(review): classify nonexistent UUID in viewIssue as LinearApiError
- `139eece` feat(linear): add createLinearClient GraphQL ops over injectable fetch
- `ef3a57b` feat(linear): resolve Linear API key with env/file precedence
- `5b75da9` feat(linear): add parseLinearRef + issue-14 spec/plan

## Findings

### Correctness

**1. `addComment` / `moveToDone` never check the mutation `success` field → null deref** — `packages/core/src/linear-api.ts:387`, `:420`

```js
return { id: data.commentCreate.comment.id };          // comment can be null
return { id: data.issueUpdate.issue.id, state: ... };  // issue can be null
```

Linear can return HTTP 200 with no `errors` but `{ success: false, comment: null }`
(archived issue, permission edge, soft rate-limit). `request()` returns normally,
then `.id` throws a `TypeError`. The outer `try/catch` in `linear-cli.ts:223`
catches it but surfaces it as `Linear error: Cannot read properties of null
(reading 'id')` — unclassified (not a `LinearApiError`) and useless to the agent.
Check `success` and throw `LinearApiError("...", "request")`. The declared types
(`comment: { id: string }`, `issue: RawIssue`) hide this by pretending the fields
are non-nullable.

**2. `comment` accepts an empty body file** — `packages/core/src/linear-cli.ts:188`

```js
const body = deps.readFile(flags["body-file"]);
if (body == null) { ... return 2; }   // "" passes this guard
```

A 0-byte body file → `addComment(id, "")`, which posts an empty comment or errors
cryptically. The completion playbook relies on this comment carrying the
branch/PR info. Reject empty/whitespace-only with the same exit 2.

**3. Help text still labels `--watch`/`--issue` as "ghafk-only"** — `packages/core/src/cli-help.ts:337,339`

```
--watch  ... (ghafk-only; default: off)
--issue <ref>  target a single GitHub issue ... (ghafk-only; default: off)
```

`printHelp` is shared and called for every bin (`run-bin.ts:105`), so
`otto-linear-afk --help` advertises these as GitHub-only/unsupported — contradicting
the bin that honors `ENG-123`/UUID/Linear-URL refs. The *error* messages were
updated ("otto-ghafk and otto-linear-afk"); the help text was missed.

**4. `parseLinearRef` URL regex is unanchored** — `packages/core/src/linear-api.ts:21`

```js
const URL_IDENTIFIER_RE = /\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:[/?#]|$)/;
```

`.match` against an unanchored pattern accepts any string *containing* `/issue/ENG-1/`,
including non-Linear URLs (`https://evil.example/issue/ENG-1/x` → `ENG-1`). Output
stays shell-safe, so it is not a security hole, but the documented contract is
"reject anything malformed" — a typo'd ref silently resolves to a wrong-but-valid
issue instead of erroring. Anchor the host (`linear.app`) or the full string.

### Efficiency / cleanup

**5. `dump` does an N+1 sequential fetch storm** — `packages/core/src/linear-cli.ts:168-177`

```js
const summaries = await client.listIssues(opts);
for (const s of summaries) {
  details.push(await client.viewIssue({ kind: "identifier", identifier: s.identifier }));
}
```

For a 50-issue backlog (the default `--limit`) that is 1 + 50 serialized round
trips **every iteration**, vs. the gh path's single `gh issue list --json …,body,comments`.
The `listIssues` query could select `description` + a bounded `comments { nodes }`
and collapse this to one request — faster and far less likely to trip the rate
limits the PR itself worries about for watch mode. At minimum, `Promise.all` the
per-issue calls.

**6. `printConfig` re-implements the watch-label decision instead of reusing `resolveWatchLabel`** — `packages/core/src/cli-help.ts:441-443`

`RunBinConfig.resolveWatchLabel` exists to make this injectable, but `printConfig`
hardcodes a `mode === "linear" ? OTTO_LINEAR_LABEL : OTTO_WATCH_LABEL` branch that
must stay manually in sync with `run-bin.ts:302`. A third provider means updating
two places that can silently diverge — the drift the reported config is meant to
prevent.

**7. Host deps duplicated across three new modules** — the identical
`readFile: (p) => { try { return readFileSync(p,"utf8") } catch { return null } }`
+ `home: homedir()` appear in `linear-api.ts:84`, `linear-cli.ts:36`,
`linear-auth.ts:56`, and the `out`/`err` line-writers in both CLI modules. One
shared `readFileOrNull`/default-host helper would stop this multiplying with each
future provider.

### Security (defense-in-depth, low)

**8. Credential write is chmod-after-write and non-atomic** — `packages/core/src/linear-auth.ts:63-68`

```js
writeFileSync(p, contents, { mode });  // mode only applies on CREATE
chmodSync(p, mode);                     // tightens an existing file afterward
```

The comment correctly notes `mode` only applies on creation, but the fix writes
the token into a pre-existing (possibly `0644`/attacker-pre-created) file *first*,
then tightens — a brief window where the plaintext key is world-readable. It is
also non-atomic, so a crash mid-write can truncate a valid prior token. Write to a
temp file with `mode: 0o600` and `rename()` into place to close both gaps.

### Minor / noted

- **`runWatch` doesn't thread `mode` into `runLoop`** (`watch.ts:227`) → Linear
  watch runs persist `state.json` under the default `mode: "afk"` while a non-watch
  `otto-linear-afk` run uses `"linear"`, so `matchesResume` (`loop.ts:266`) won't
  resume across the two. Pre-existing for ghafk watch too; the new Linear caller
  inherits it. Low impact.
- **`wasIdle` resets on every failed poll** (`watch.ts:214`) → alternating
  poll-failure/empty-queue cycles re-announce the idle banner the latch was added
  to suppress. Minor log noise.

## Refuted

- Preflight eagerly resolving Linear auth for every mode — false; `linearAuth()`
  is only called when `bin === "otto-linear-afk"` (`preflight.ts:104`).
- `done` team-key `split("-")[0]` breaking on multi-segment keys — false; Linear
  team keys are alphanumeric with no hyphens, so `ENG-123` → `ENG` is correct.
- `redirect`/TLS endpoint hardening — endpoint defaults to `https://api.linear.app`
  and is overridable only for tests/self-hosting; low-value defense-in-depth.
