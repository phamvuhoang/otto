# issue-14 — otto-linear-afk

GitHub issue #14 (OPEN). Theme: a Linear-issue-driven AFK loop (`otto-linear-afk`)
parallel to the existing `otto-ghafk` GitHub loop, backed by Linear personal API
keys and a bundled `linear` helper + `otto-linear-auth` credential tool.

## Problem

The issue is a detailed v1 recommendation, not a single change. It spans: auth
storage + resolution, a `linear` GraphQL helper CLI, two new stages + three
templates, `runLinearAfk` parallel to `runGhAfk`, Linear ref parsing, issue
selection by label/team, watch-mode polling, and completion behaviour (comment
vs. move-to-done). Per the AFK workflow it must be decomposed into a spec +
ordered plan; each run implements exactly one plan task, test-first.

Reconciled against reality (git log + working tree, 2026-06-16): nothing
Linear-related exists yet (`find -name '*linear*'` is empty; `otto/14` is at
`main`). This is a greenfield feature on a fresh branch.

## Approach

Mirror the existing GitHub loop's structure so the new mode reuses the proven
spine (`runBin` → `runLoop` → stages/templates → reviewer). Net-new Linear
concerns live in dedicated, pure, unit-testable modules so tests run without
network or a real credential file — matching the repo convention (see LEARNINGS:
"Pure functions that touch the host take injectable probes/deps").

Key building blocks, in dependency order:

1. **`parseLinearRef`** (pure) — normalize a user `--issue` value (Linear
   identifier `ENG-123`, issue UUID, or a `linear.app/.../issue/ENG-123/...`
   URL) to a discriminated `{ kind, value }`. SECURITY: like `parseIssueRef`,
   the normalized value is the only part of a ref that may reach a shell (via a
   static template command reading an env var), so the parser must reject any
   value containing shell metacharacters. The identifier/uuid regexes guarantee
   `[A-Z0-9-]` only.
2. **Auth resolution** (pure, injectable fs/env) — precedence
   `OTTO_LINEAR_API_KEY` → `LINEAR_API_KEY` → `~/.config/otto/linear.json`
   (`{ "type": "apiKey", "token": "..." }`, `0600`). Returns the token + its
   source, or null. Config shape kept extensible for a future OAuth `type`.
3. **`otto-linear-auth`** bin — `login` (stdin paste → write `0600` file
   outside the repo), `status` (`--verify-live` optional), `logout`.
4. **`linear-api.ts`** — narrow GraphQL ops over Node 20 `fetch`
   (`Authorization: <API_KEY>`): list/dump labelled open issues, view one,
   comment, move-to-done. Injectable `fetch` for tests; no `@linear/sdk`.
5. **Bundled `linear` helper CLI** — `list/dump/view/comment/done`, used by
   templates and the agent (parallels `gh`).
6. **Stages + templates** — `STAGES.linearImplementer` (`linearafk.md`) and
   `STAGES.linearIssueImplementer` (`linearafk-issue.md`), plus playbook
   `linearprompt.md`; reuse the existing reviewer stage.
7. **`runLinearAfk`** parallel to `runGhAfk`, threading a new `mode: "linear"`,
   `--issue` (via `parseLinearRef`), `--print-config` Linear-auth line, and
   provider-specific `--watch` polling that classifies auth failures distinctly.

## Assumptions (autonomous brainstorm — no human in the loop)

- **Q: One mega-PR or incremental?** → Incremental: one plan task per AFK run,
  each shippable + tested. Rationale: AFK workflow mandates single-task commits;
  the loop reviews/refines across rounds.
- **Q: Where does `parseLinearRef` live?** → `linear-api.ts` (or a small
  `linear-ref.ts`); Linear-domain logic stays together, not in the GitHub-shaped
  `cli-help.ts`. Chosen: start it in `linear-api.ts`. Rationale: keeps the
  GitHub `parseIssueRef` and Linear parsing from cross-contaminating.
- **Q: Auth file location/format?** → `~/.config/otto/linear.json`, `0600`,
  `{ "type": "apiKey", "token": "..." }`. Rationale: issue spec; extensible for
  OAuth later.
- **Q: SDK or raw fetch?** → raw `fetch`. Rationale: issue spec — keep core's
  dependency surface at zero (both packages are dependency-free today).
- **Q: Watch default interval?** → 300s (issue spec; Linear discourages
  aggressive polling). Rationale: matches `ghafk` watch default and Linear's
  rate-limit guidance.
- **Q: Identifier case?** → uppercase the team key (`eng-12` → `ENG-12`).
  Rationale: Linear canonical identifiers are uppercase; case-insensitive input
  is friendlier.

## Testing notes

- `parseLinearRef`: accept identifier / UUID / URL (with and without slug/
  trailing segments) and case-insensitivity; reject empty, shell-metachar,
  malformed identifiers, bad UUIDs. Mirrors `cli-help.test.ts` `parseIssueRef`.
- Auth resolution: precedence order + missing → null, with injected env/fs.
- `linear-api`: mock `fetch`, assert request shape (URL, auth header, GraphQL
  body) and response parsing; never hit the network.
- Templates: render-contract smoke (renderer surfaces the spilled issue file;
  static-shell-tag invariant holds — only the validated ref reaches a command).
- Watch: poll classification (idle / auth / error), injected poller.
