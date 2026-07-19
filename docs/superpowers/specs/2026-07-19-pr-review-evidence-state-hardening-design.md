# P32 Review Evidence and State Hardening Design

**Status:** Approved

**Date:** 2026-07-19

**Scope:** Close the three remaining PR #213 review findings without changing the public review workflow or the OS-flock lease decision.

## Goal

Make every terminal `otto-review` record truthful and restart-safe when review-input persistence fails, analysis fails, or publication resumes an existing run.

## Root causes

1. Review-input durability is represented twice—`manifest.artifacts[]` and `pullRequestReview.reviewInput.artifactPath`—but only the artifact list currently observes the durability result.
2. The shared analysis-failure helper finalizes a report and manifest without writing `PullRequestReviewState`, so watch mode reads no state and schedules the same identity again.
3. Resume finalization rebuilds a reused run ID's manifest from current-invocation fields and carries forward only cost and token totals, dropping prior provenance and artifacts.

## Design

### 1. Durable-or-explicitly-unavailable review input

`PullRequestReviewEvidence.reviewInput.artifactPath` becomes `string | null`. A non-null value means the exact input was written and round-trip verified. `null` means persistence failed or validation did not prove the artifact durable.

One run-scoped `inputArtifactDurable` flag controls both evidence representations:

- `manifest.artifacts[]` includes `review-input` only when the flag is true;
- structured review evidence uses the expected path only when the flag is true, otherwise `null`;
- operator views render `null` as `(unavailable)` and never print `undefined`;
- canonical successful reviews retain the required non-null snapshot path because analysis cannot start until the input round trip succeeds.

The initial in-progress manifest starts without an input artifact reference. After the write/read round trip succeeds, subsequent manifests include it. Any failure before that point finalizes without claiming the file exists.

### 2. Analysis failures participate in the state machine

Every `analysis-failed` result persists a state record before returning:

- `status: "analysis-failed"`;
- `attempts: priorAttempts + 1`;
- preserved output receipts, if any;
- the exact error message;
- explicit `retryable` classification;
- `nextRetryAt` for retryable failures, using the existing bounded retry schedule.

Permanent failures include invalid review-skill selection, input persistence/validation failure, worktree input-integrity failure, and analysis contract violations. Transient failures include worktree creation/runtime failures, generic model execution failures, budget exhaustion, and unexpected analysis-path errors. Permanent failures are not selected again automatically by watch mode; transient failures are selected only after their retry timestamp. An explicit one-shot invocation may retry a permanent `analysis-failed` identity after the operator fixes its cause. This keeps unattended watch runs from hot-looping while preserving the documented fix-and-rerun recovery path.

### 3. Resume merges prior manifest provenance

When a validated analysis artifact reuses an existing run ID, the whole prior manifest is retained as the historical base. Finalization preserves:

- original `startedAt`;
- original producing runtime;
- prior `toolsUsed` evidence;
- prior artifacts, including an already-written canonical review;
- cumulative cost and token usage.

Current terminal information replaces only the fields that legitimately advance: `exitReason`, `finishedAt`, review evidence/receipts, completed-iteration state, and cumulative totals. Artifact and tool arrays are merged deterministically without duplicate `(kind,path)` artifacts or duplicate tool records.

The returned `costUsd` remains per invocation so watch-budget accounting does not charge the original analysis twice.

### 4. Documentation consistency

The approved P32 design and implementation plan use “OS-flock lease” consistently instead of the superseded claim/heartbeat vocabulary. The Task 11 interface section uses valid Markdown fences so the supersession note renders as prose.

## Testing

Each behavior follows RED → GREEN:

1. Inject a review-input write failure and assert neither `artifacts[]` nor structured evidence references the missing file; assert operator output says `(unavailable)`.
2. Force a permanent paid analysis contract failure and assert durable `analysis-failed` state prevents watch reselection; force a transient analysis failure and assert bounded retry metadata.
3. Seed a resumable manifest with a distinct runtime, original start time, tool usage, and canonical-review artifact; pre-abort the resume and assert all prior provenance survives while cost is not double-counted.
4. Add documentation assertions or direct Markdown checks for the corrected lease terminology and fence structure.

Focused review tests run after each fix. Completion requires `pnpm -r typecheck`, `pnpm -r test`, `pnpm test`, `pnpm -r build`, and `node scripts/smoke-pack-install.mjs`.

## Non-goals

- Replacing `fs-ext` or changing the OS-flock lease.
- Redesigning publication markers or the client-side freshness contract.
- Introducing per-invocation child manifests or a run-schema migration.
- Changing normal successful review output.
