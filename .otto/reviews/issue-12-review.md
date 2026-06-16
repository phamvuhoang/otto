# Code review — issue #12 (`otto/12`): "Prepare for broader adoption"

Date: 2026-06-16 · Branch: `otto/12` vs `origin/main` · Scope: `git diff origin/main...otto/12`

## Summary

A docs + contract-test PR; the only code change is the root `test` script.
Overall low-risk and well-built: the run-mode docs are accurate (every stage
name, chain mapping, the sentinel literal, and the gate/reviewer invariants
check out against `stages.ts`/`run-bin.ts`/`loop.ts`), and the
`releasing`/`security` contract tests do real bidirectional source-derivation
(`deepEqual` on `files`, `permissionMode` set-equality) rather than tautologies.
The glob change has a side benefit: issue #8's `cli-docs-recipes.test.mjs` was
**never run** by the old explicit 3-file `test` script — the glob now executes
it (33 root tests vs the prior list that skipped it).

Findings are one real packaging gap (#1) plus several "pins-less-than-it-claims"
test weaknesses.

Commits in scope:

- `d8b0305` docs(contributing): document run-mode extension point + pin it
- `a4c05ec` fix(review): pin --issue flag and ghafk-issue-implementer in docs test
- `7f4bb27` test(release): pin RELEASING.md package contents + wire contract tests via glob
- `39f627b` test(security): pin SECURITY.md threat model against source defaults
- `5d2a26a` docs(beta): add beta-feedback capture template + ranking rubric
- `0b589b5` fix(review): pin beta rubric axes instead of tautological rank check

## Findings

### 1. `RELEASING.md:204` — claims each tarball ships a `LICENSE`; it doesn't

> "Each tarball ships … (plus the npm-implicit `package.json` and **LICENSE**)."

`LICENSE` exists **only at the repo root** — not in `packages/core/` or
`apps/cli/`, and not in either `files` array. npm auto-includes `LICENSE` only
when it is *in the package's own directory*, so **both published tarballs ship
with no license text** (only the `"license": "MIT"` field). For a public MIT
release that is a real compliance/expectation gap, not just a doc typo. The
contract test the doc cites as its guard (`releasing-contract.test.mjs`) pins the
`files` arrays — it does **not** check the LICENSE claim.

**Fix:** add a `LICENSE` to each package dir (+ to `files`) so it actually ships
— recommended — or correct the doc. **Severity:** medium.

### 2. `package.json:17` — `node --test scripts/*.test.mjs` is fragile on Windows + Node 20

Native glob support in `node --test` landed in **Node 21**, but `engines` is
`node: >=20` and CI pins 20. On CI (ubuntu, `sh` expands the glob) it works. On a
**local Windows** contributor's machine, `cmd.exe` doesn't expand `*.test.mjs`
and Node 20 has no native glob → Node gets a literal nonexistent path and the
root suite errors / runs nothing. The repo supports Windows (`resolveShell`
walks `bash.exe`/`cmd.exe`), and the prior explicit list worked everywhere.

**Fix:** keep an explicit list, use a glob runner / `for`-loop, or raise the
engines floor. **Severity:** low-medium (CI unaffected).

### 3. `scripts/contributing-extension-points.test.mjs:26` — stage-name regex over-matches

`/name:\s*"([^"]+)"/g` greps the **whole** `stages.ts` for any `name: "..."`, not
the `STAGES` registry keys. If a stage is renamed but the old string survives
anywhere in the file (a comment, a deprecated alias, a template filename),
`names.has("verifier")` stays true and the test passes while docs+registry have
drifted — contradicting the test's own "a rename fails this test" comment.

**Severity:** low-medium (weaker pin than claimed).

### 4. `scripts/security-doc-contract.test.mjs:103` — pins a comment, not the behavior

`/SECURITY INVARIANT[\s\S]*INPUTS[\s\S]*substituted LAST/i` spans all of
`render.ts` and only requires those tokens to appear in order. If the actual
regression the doc warns against happened — `INPUTS` moved to substitute *first*
— but the stale comment stayed, the assertion still passes. It guards the
existence of a comment, not that `INPUTS` is genuinely substituted last.
(`includes("execSync")` likewise only proves the string appears.)

**Severity:** low-medium.

### 5. `scripts/releasing-contract.test.mjs:73` — workflow regex misses `.yaml`, forward-only

`/[\w-]+\.yml/g` drops any `.yaml` workflow (or names broken by surrounding
chars) from the checked set, and there is no reverse check that the real
publish/release workflows are all named in `RELEASING.md` (only `publish-npm.yml`
is hardcoded). A renamed/added workflow goes unnoticed.

**Severity:** low.

### 6. `scripts/beta-feedback-contract.test.mjs:38` — author-controlled, no source of truth

The rubric dimensions/axes are literals defined in the test and checked as
substrings of the same-PR-authored `docs/BETA.md` + issue template; issue #12's
text is never parsed. It pins "these strings still exist in files I control,"
not conformance to what the issue requires — largely inherent to a process-doc
test. The `fix(review)` commit already de-tautologized the rank check.

**Severity:** low.

## Verified clean

- **Run-mode docs accurate** — `--verify` → `[verifier]`, `--apply-review` →
  `[apply-review-implementer, …rest]`, `--issue` → `[ghafk-issue-implementer,
  …rest]` all match `run-bin.ts`; sentinel string, gate-at-index-0,
  reviewer-never-gates all match `loop.ts`; mutual-exclusivity matches the
  `modeCount` guard.
- **`releasing`/`security` `files`/`permissionMode` pins** are genuine
  bidirectional `deepEqual`/set-equality checks — not tautologies.
- The glob fix makes `cli-docs-recipes.test.mjs` actually run in the root suite.

## Recommended before merge

1. **#1** — ship a real `LICENSE` in each package (public MIT release) or correct
   the RELEASING.md claim.
2. #2–#6 — test-hardening; safe to fix now or defer with rationale to
   `.otto/review-followups.md`.
