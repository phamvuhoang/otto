# Review follow-ups

## 2026-06-16 — issue #5 review (`.otto/reviews/issue-5-review.md`)

- **#2 `preflight.ts:69` claude-auth false positive** (medium-high) — deferred:
  the review's suggested fix (probe `~/.claude/.credentials.json`) regresses on
  macOS, where `claude /login` stores the OAuth token in the Keychain and that
  file is never written → false negative. A correct cross-platform login probe
  (inspect `~/.claude.json` `oauthAccount`, or platform-specific keychain check)
  is larger than a one-line path swap; needs design.
- **#3 `preflight.ts:91` gh-auth false positive** (medium) — deferred, same
  class as #2; also should honour `GH_CONFIG_DIR` and probe `hosts.yml`.
- **#4 `loop.ts:359` abort during `--cooldown` mislabels as `stopped (error)`**
  (medium-low) — deferred: the cooldown `sleep` sits in the outer try, so an
  abort there rejects past the inner guard. Fix is real but a separate code path
  from #1; addressing next iteration.
- **#5 `preflight.ts:37` `whichBin` uses `existsSync` only** (low) — deferred:
  a directory/non-executable named `claude`/`gh` on PATH reports a false `✓`.
  Harden with `statSync().isFile()`.
- **#6 `loop.ts:327` stage failure `break`s only the inner loop** (low,
  pre-existing) — design-intent question, not a diff regression. "Keep going
  after a failed stage" appears intentional; flag for product confirmation, no
  code change.
