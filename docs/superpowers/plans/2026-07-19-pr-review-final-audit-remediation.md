# Automated PR Review Final-Audit Remediation Plan

**Goal:** Close every Critical, Important, and Minor issue found by the final full-PR audit before PR #213 is declared merge-ready.

**Base reviewed:** `196c519`

**Required invariants:**

- Persisted analysis is untrusted input on resume and must pass a strict runtime schema plus identity/path/integrity validation before it can drive publication.
- Model-controlled text can never create a syntactically valid Otto ownership/idempotency envelope.
- Recovery evidence must describe the recovered verdict and finding counts truthfully.
- Composite state remains keyed by repository, PR, head, and input fingerprint, while the one mutable per-PR summary comment is additionally serialized by a PR-scoped publication flock.
- State/run decisions that can trigger work are re-read after the composite flock is acquired.
- A prior success is complete only for the output sinks requested by the current invocation; missing sinks resume from validated analysis without new model cost.
- Durable state writes are mandatory. A run never returns `succeeded` when its terminal state was not persisted.
- Watch preflight and fatal platform/storage errors fail once and exit cleanly instead of polling forever.
- Existing unrelated workspace changes remain untouched.

---

## Task 1: Harden persisted analysis, marker envelopes, and recovery evidence

**Files:**

- Modify: `packages/core/src/pr-review.ts`
- Modify: `packages/core/src/pr-review-output.ts`
- Modify: `packages/core/src/pr-review-publish.ts`
- Test: `packages/core/src/__tests__/pr-review-output.test.ts`
- Test: `packages/core/src/__tests__/pr-review-publish.test.ts`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`

### RED tests

Add adversarial regressions proving:

1. `readReviewAnalysisArtifact` rejects each independently corrupted field: run ID, base SHA, URL/title type, review-input kind/source/fingerprint/path, outcome, confirmed finding schema/severity/location, rejected finding schema, severity tally, skill selection, diff path, missing/non-regular diff artifact, and mismatched diff integrity. Rejection must allocate a fresh run and invoke analysis rather than publish persisted content.
2. A finding claim/why/fix/file/lens or PR title/input source containing `<!-- otto-review... -->` cannot create an additional valid summary, head, input, or formal-review marker.
3. Summary reconciliation and lost-state recovery accept only one canonical fixed-position summary envelope with no extra reserved marker occurrences; formal-review recovery accepts only one fixed-position composite envelope.
4. A forged future head/input marker embedded in model text cannot cause later recovery or reuse.
5. Lost-state recovery of an approved/comment/changes-requested canonical body records the actual outcome, confirmed total, and rejected count in `manifest.pullRequestReview`, not default zero/absent evidence.

### Implementation

- Replace the cast-based artifact reader with an explicit runtime parser. Validate the entire persisted shape and every enum/number/string collection.
- Bind the artifact to the requested run and resolved review input. Persist and validate a SHA-256 digest for the exact diff artifact (bump the local analysis schema if needed; older/incomplete artifacts safely fall back to fresh analysis).
- Require artifact paths to equal the run-owned canonical relative paths and resolve to regular files within the run directory. Do not follow symlinks outside the run bundle.
- Add canonical-envelope parsers for summary and formal-review bodies. Markers must occupy their documented fixed lines, occur exactly once, and no other `<!-- otto-review` occurrence is allowed.
- Escape the reserved marker prefix in every model/user-controlled field before rendering canonical, formal, and inline output.
- Use canonical-envelope parsing everywhere ownership/current identity is reconciled, including recovery; remove unrestricted `includes(marker)` authority.
- Parse the deterministic canonical verdict/count lines during recovery. If the remote body is not a valid canonical document, do not declare recovery success; fall through to fresh analysis/update.

### Verification

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-output.test pr-review-publish.test pr-review-pipeline.test
pnpm --filter @phamvuhoang/otto-core typecheck
```

Commit: `fix(p32): authenticate persisted and remote review evidence`

---

## Task 2: Serialize shared publication and revalidate state/output decisions under the lease

**Files:**

- Modify: `packages/core/src/pr-review-state.ts`
- Modify: `packages/core/src/pr-review.ts`
- Modify: `packages/core/src/pr-review-publish.ts` only if the publication-lease seam belongs there
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/pr-review-state.test.ts`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`
- Test: `packages/core/src/__tests__/pr-review-publish.test.ts`

### RED tests

Add deterministic concurrency/state regressions proving:

1. Two fingerprints for the same PR can hold independent composite analysis leases, but their summary list/create operations serialize on a persistent PR-scoped publication flock. The second publisher re-lists under that flock and updates/reuses the first comment; exactly one summary comment exists.
2. A waiter that observed no state before blocking on the composite lease re-reads after acquisition. If the first holder reached `succeeded`, the waiter returns cost zero and never analyzes or emits local output.
3. A waiter that discovers `running`/`publish-failed` plus valid analysis under the lease resumes the prior run ID without model work.
4. A previously `succeeded` text run invoked as comment, formal review, comment-plus-review, or Markdown resumes only the missing current sinks from validated analysis. Existing receipts remain; no model stage reruns.
5. A success whose currently requested sinks are already complete still short-circuits cost-free.

### Implementation

- Keep composite state and the composite run flock keyed by repository/PR/head/fingerprint.
- Add a second persistent stable-inode flock keyed only by repository/PR for the mutable summary-comment reconcile/write section. All lock acquisition order is composite lease first, publication lease second; release publication lease immediately after summary reconcile/write.
- Treat the pre-lock state read only as a fast-path hint. After acquiring the composite flock, read state again and make the authoritative terminal/resume/fresh decision from that record.
- If initialization currently depends on `runId`, use a provisional lease owner ID, then initialize the authoritative run ID/run paths/builders only after the under-lock state decision. Never finalize into the provisional run bundle when resuming.
- Define current required sinks from `config.output` and `config.githubReview`. `succeeded` is terminal only when every current sink receipt exists.
- Allow a succeeded state with missing sinks and a valid analysis artifact into the resume-publication path. Preserve prior receipts and current per-invocation cost `0`.
- Recheck abort/lease ownership immediately after the final `getPullRequest` returns and before each remote mutation is authorized.

### Verification

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-state.test pr-review-publish.test pr-review-pipeline.test
pnpm --filter @phamvuhoang/otto-core typecheck
```

Commit: `fix(p32): serialize publication and recheck state under lease`

---

## Task 3: Fail closed on durable-state/platform errors and align watch/CLI contracts

**Files:**

- Modify: `packages/core/src/pr-review-state.ts`
- Modify: `packages/core/src/pr-review.ts`
- Modify: `packages/core/src/pr-review-watch.ts`
- Modify: `packages/core/src/review-main.ts`
- Modify: `packages/core/src/review-cli.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`
- Test: `packages/core/src/__tests__/pr-review-watch.test.ts`
- Test: `packages/core/src/__tests__/review-main.test.ts`
- Test: `packages/core/src/__tests__/review-cli.test.ts`
- Test: public export/package-shape tests as applicable

### RED tests

Add regressions proving:

1. Failure of the initial `running` state write stops before analysis.
2. Failure to persist a comment/formal-review receipt finalizes local evidence with the in-memory proven receipt, returns/throws a typed unrecoverable storage failure, and never performs the next remote write.
3. Failure of the terminal `succeeded` write never returns success. Text/Markdown watch does not reselect and repay in a loop; the daemon exits through its unrecoverable failure path.
4. Missing/broken `fs-ext`, `ENOTSUP`, and the typed state-persistence failure make watch attempt once, release keepalive/listeners, notify/report once, and exit; ordinary transient revision failures still continue.
5. Watch performs the same viewer/auth, exact-label, and origin/repository preflight as one-shot before polling/model work.
6. One-shot surfaces typed lease/storage failures as concise actionable one-line errors without a raw stack.
7. `--max-retries 0` is accepted as fail-fast, matching the shared CLI contract.
8. watch interval/cooldown/retry integers reject unsafe/non-safe/timer-overflow values instead of letting Node clamp them into hot polling.
9. `ReviewLeaseError` and the new typed state-persistence error are exported from the public barrel.

### Implementation

- Introduce/export `ReviewStatePersistenceError` carrying the state path and cause. Remove the best-effort swallow from `persistState`.
- Before analysis, propagate the typed error directly. After analysis or a remote write, first finalize coherent manifest/report evidence from the in-memory analysis/receipts, then propagate an unrecoverable typed error; do not recursively require another successful state write to describe the failure.
- Watch must rethrow typed lease/storage/platform errors to the outer daemon failure/notification path and continue only errors that can plausibly recover on a later poll.
- Factor the shared GitHub viewer/label/origin preflight so watch and one-shot execute identical checks before review work (after detached-child establishment, before polling).
- Catch typed one-shot errors at `runReview` and emit one actionable line with exit code 1.
- Accept non-negative safe `maxRetries`. Validate timer-backed values as safe integers within Node's supported delay range (or use chunked sleeping); reject overflow with an actionable flag error.
- Export typed public errors and lock their package-root availability with tests.

### Verification

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test pr-review-watch.test review-main.test review-cli.test pr-review-state.test
pnpm --filter @phamvuhoang/otto-core typecheck
pnpm test
```

Commit: `fix(p32): fail closed on review state and platform errors`

---

## Task 4: Align documentation and run the final release gate

**Files:**

- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: original P32 spec/plan and hardening spec/plan where contracts changed
- Modify: `scripts/review-cli-docs.test.mjs`

### Documentation contracts

- Document composite state/run flock versus PR-scoped summary-publication flock and their fixed acquisition order.
- Document that persisted analysis and remote bodies are strictly schema/envelope validated before resume/recovery.
- Document current-output completion semantics and cost-free missing-sink resume.
- Document fail-closed state persistence, watch preflight, fatal native/local-filesystem behavior, `--max-retries 0`, and timer bounds.
- Add contract assertions that prevent the old composite-only publication, best-effort state, and shallow-resume wording from returning.

### Full verification

Run from the final committed HEAD:

```bash
pnpm -r typecheck
pnpm -r test
pnpm test
pnpm -r build
node scripts/smoke-pack-install.mjs
git diff --check afc5d5c..HEAD
```

Required result: all gates pass, package smoke records zero GitHub writes, and unrelated dirty files remain untouched.

Commit: `docs(p32): document final review safety contracts`
