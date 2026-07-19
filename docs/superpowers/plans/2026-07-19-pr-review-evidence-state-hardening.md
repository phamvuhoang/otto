# P32 Review Evidence and State Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `otto-review` terminal evidence truthful when input persistence fails, persist analysis failures with bounded retry semantics, and preserve complete run provenance across publication resumes.

**Architecture:** Keep the existing P32 pipeline and OS-flock lease. Introduce one run-scoped input-durability authority used by both evidence representations, route every analysis failure through the existing composite state machine, and merge a resumed run's prior manifest into the next terminal manifest rather than reconstructing it from current-only fields.

**Tech Stack:** TypeScript with NodeNext ESM, Node.js ≥20, Vitest, Node's built-in test runner, Markdown contract tests, pnpm monorepo.

## Global Constraints

- Preserve the native `fs-ext` OS-flock lease; do not replace or weaken it.
- Keep analysis read-only and credential-scrubbed; these fixes do not change model permissions or publication authority.
- Keep returned `costUsd` per invocation so watch budgets never charge prior analysis twice.
- A manifest may reference `review-input.md` only after byte-exact round-trip verification.
- Existing successful review output and GitHub marker/idempotency behavior remain unchanged.
- Do not edit package versions or `.release-please-manifest.json`.
- Every production behavior change follows RED → GREEN with the focused test named in its task.
- Preserve unrelated dirty worktree files.

---

### Task 1: Make review-input evidence durable or explicitly unavailable

**Files:**

- Modify: `packages/core/src/run-report.ts:178-216`
- Modify: `packages/core/src/inspect.ts:63-87`
- Modify: `packages/core/src/pr-review.ts:499-743,1715-1756`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`
- Test: `packages/core/src/__tests__/inspect.test.ts`
- Test: `packages/core/src/__tests__/run-report.test.ts`

**Interfaces:**

- Consumes: `writeReviewInput`, `readReviewInput`, `artifactList`, `buildEvidence`, `PullRequestReviewEvidence`.
- Produces: `PullRequestReviewEvidence.reviewInput.artifactPath: string | null`; one `inputArtifactDurable` flag controlling both structured evidence and `RunManifest.artifacts`.

- [ ] **Step 1: Write failing pipeline assertions for both manifest references**

Extend the existing `(O1/#defect1)` test so the injected write failure proves the whole manifest is truthful:

```ts
const evidence = m.pullRequestReview as PullRequestReviewEvidence;
expect(evidence.reviewInput.artifactPath).toBeNull();
expect(JSON.stringify(m)).not.toContain(
  `.otto/runs/${res.runId}/review-input.md`
);
```

Add a second case for the fresh `writeReviewInput` failure path:

```ts
it("a fresh review-input write failure finalizes without either input reference", async () => {
  const res = await runPullRequestReview({
    ...baseArgs(fx),
    reviewInput: resolvedInput(fx),
    config: makeConfig({ output: "text" }),
    deps: {
      analyze: makeFakeAnalyze({}).fn,
      github: makeCommentGithub({ current: () => fx.revision }).github,
      stdout,
      now,
      writeReviewInput: () => {
        throw new Error("run dir is unwritable");
      },
    },
  });
  expect(res.status).toBe("analysis-failed");
  const manifest = readManifest(fx.workspaceDir, res.runId);
  expect(
    (manifest.pullRequestReview as PullRequestReviewEvidence).reviewInput
      .artifactPath
  ).toBeNull();
  expect(
    (manifest.artifacts as RunArtifact[]).some(
      (artifact) => artifact.kind === "review-input"
    )
  ).toBe(false);
});
```

In `inspect.test.ts`, update the existing string-path assertion with a non-null
assertion (`pullRequestReview.reviewInput.artifactPath!`), then add an evidence
fixture with `artifactPath: null` and assert:

```ts
const unavailableInput: PullRequestReviewEvidence = {
  ...pullRequestReview,
  reviewInput: { ...pullRequestReview.reviewInput, artifactPath: null },
};
const out = formatRunReport(
  {
    ...finalized,
    mode: "github-pr-review",
    pullRequestReview: unavailableInput,
  },
  []
);
expect(out).toContain("artifact (unavailable)");
expect(out).not.toContain("artifact undefined");
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test inspect.test run-report.test
```

Expected: FAIL because `artifactPath` is still required/string, `buildEvidence()` still supplies the missing path, and the fresh failure still uses the default artifact list.

- [ ] **Step 3: Implement one durability authority**

In `run-report.ts`, change only the evidence type, not `ReviewInputSnapshot`:

```ts
reviewInput: {
  kind: ReviewInputRequest["kind"];
  source: string;
  fingerprint: string;
  /** Null only when the exact artifact could not be durably materialized. */
  artifactPath: string | null;
}
```

In `pr-review.ts`, initialize durability from validated resume state and use it as the default for both builders:

```ts
let inputArtifactDurable = resumedAnalysis !== null;

const buildEvidence = (
  over: Partial<PullRequestReviewEvidence> = {},
  includeInput = inputArtifactDurable
): PullRequestReviewEvidence => ({
  // existing identity fields
  reviewInput: {
    kind: reviewInput.kind,
    source: reviewInput.source,
    fingerprint: inputFingerprint,
    artifactPath: includeInput ? expectedInputPath : null,
  },
  // existing defaults and ...over
});

const artifactList = (
  over: RunArtifact[] = [],
  includeInput = inputArtifactDurable
): RunArtifact[] => [
  ...(includeInput
    ? [{ kind: "review-input", path: expectedInputPath } as RunArtifact]
    : []),
  ...over,
];
```

Set `inputArtifactDurable` only after proof:

```ts
inputArtifactDurable =
  roundTrip != null && roundTrip.content === reviewInput.content;
```

The initial manifest uses the default `false` on a fresh run. After the fresh write/read succeeds, set `inputArtifactDurable = true` before later stages. `materializeReferencedInput()` updates the same flag and returns it. All `fail()`, abort, and recovery finalizers therefore use the same default for artifacts and structured evidence.

In `inspect.ts`, render the explicit absence:

```ts
const inputArtifact = pr.reviewInput.artifactPath ?? "(unavailable)";
// use inputArtifact in the review-input line
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test inspect.test run-report.test
pnpm --filter @phamvuhoang/otto-core typecheck
```

Expected: all named tests PASS and typecheck succeeds.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/core/src/run-report.ts packages/core/src/inspect.ts packages/core/src/pr-review.ts packages/core/src/__tests__/pr-review-pipeline.test.ts packages/core/src/__tests__/inspect.test.ts packages/core/src/__tests__/run-report.test.ts
git commit -m "fix(p32): make input evidence durable or unavailable"
```

---

### Task 2: Persist analysis failures with explicit retry semantics

**Files:**

- Modify: `packages/core/src/pr-review.ts:205-225,623-648,1715-2018`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`
- Test: `packages/core/src/__tests__/pr-review-watch.test.ts`

**Interfaces:**

- Consumes: `persistState`, `nextPublicationRetryAt`, `priorAttempts`, `priorOutputs`, `isStateRunnable`.
- Produces: durable `analysis-failed` states and `PullRequestReviewRunResult.retryable/nextRetryAt` for transient failures.

- [ ] **Step 1: Write failing permanent and transient state tests**

Extend the existing analysis-contract failure test:

```ts
const state = readReviewState(
  fx.workspaceDir,
  "acme/widget",
  7,
  fx.headSha,
  fp()
);
expect(state).toMatchObject({
  status: "analysis-failed",
  attempts: 1,
  retryable: false,
});

const second = await runPullRequestReview({
  /* same identity */
});
expect(second.status).toBe("analysis-failed");
expect(second.costUsd).toBe(0);
expect(fake.invocationCount()).toBe(1);
```

Add a generic model failure case:

```ts
it("persists transient analysis failures with bounded retry metadata", async () => {
  const analyze = vi.fn(async () => {
    throw new Error("temporary model transport failure");
  });
  const res = await runPullRequestReview({
    ...baseArgs(fx),
    reviewInput: resolvedInput(fx),
    config: makeConfig({ output: "text" }),
    deps: {
      analyze: analyze as never,
      github: makeCommentGithub({ current: () => fx.revision }).github,
      stdout,
      now,
    },
  });
  expect(res).toMatchObject({ status: "analysis-failed", retryable: true });
  expect(res.nextRetryAt).toBeTruthy();
  expect(
    readReviewState(fx.workspaceDir, "acme/widget", 7, fx.headSha, fp())
  ).toMatchObject({
    status: "analysis-failed",
    retryable: true,
    nextRetryAt: res.nextRetryAt,
  });
});
```

In `pr-review-watch.test.ts`, add a selection test whose `readState` returns a permanent `analysis-failed` record and assert `runRevision` is never called before shutdown.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test pr-review-watch.test
```

Expected: FAIL because `fail()` does not persist state or return retry metadata.

- [ ] **Step 3: Extend the result contract and failure helper**

Update the result documentation so retry metadata applies to both analysis and publication failures. Refactor `fail()` to accept an explicit classification:

```ts
const fail = (
  error: string,
  nextAction: string,
  retryable = false
): PullRequestReviewRunResult => {
  const attempts = priorAttempts + 1;
  const nextRetryAt = retryable
    ? nextPublicationRetryAt(attempts, deps.now())
    : undefined;
  persistState({
    status: "analysis-failed",
    outputs: priorOutputs,
    attempts,
    retryable,
    ...(nextRetryAt ? { nextRetryAt } : {}),
    error,
  });
  // existing report + manifest finalization
  return {
    status: "analysis-failed",
    runId,
    repository,
    pullRequest,
    headSha: revision.headSha,
    inputFingerprint,
    costUsd: manifestCost,
    retryable,
    ...(nextRetryAt ? { nextRetryAt } : {}),
    error,
  };
};
```

Classify calls explicitly:

- permanent/default `false`: input write or round-trip failure, invalid skill, byte-integrity mismatch, `ReviewAnalysisContractError`;
- transient `true`: worktree creation failure, generic model/runtime failure, budget exhaustion, and the outer unexpected analysis-path catch.

Do not change publication-failure classification or the existing retry delay formula.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test pr-review-watch.test pr-review-state.test review-main.test
pnpm --filter @phamvuhoang/otto-core typecheck
```

Expected: all named tests PASS; permanent failures are not runnable, and transient failures carry a future retry timestamp.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/core/src/pr-review.ts packages/core/src/__tests__/pr-review-pipeline.test.ts packages/core/src/__tests__/pr-review-watch.test.ts
git commit -m "fix(p32): persist analysis failure retry state"
```

---

### Task 3: Preserve complete manifest provenance across resume

**Files:**

- Modify: `packages/core/src/pr-review.ts:469-607,831-874`
- Test: `packages/core/src/__tests__/pr-review-pipeline.test.ts`

**Interfaces:**

- Consumes: `readManifest`, `RunManifest`, `RunArtifact`, `ToolUsage`, existing resumed `runId` and cumulative cost/token logic.
- Produces: deterministic prior/current manifest merging with current terminal status and per-invocation returned cost.

- [ ] **Step 1: Strengthen the resumed pre-abort test and verify missing provenance**

Before the second invocation, rewrite the seeded prior manifest with distinguishable provenance and a canonical-review artifact:

```ts
const seeded: RunManifest = {
  ...m1,
  runtime: { id: "claude", displayName: "Claude" },
  startedAt: "2026-07-18T00:00:00.000Z",
  toolsUsed: [
    {
      name: "headroom",
      kind: "sdk",
      stage: "pr-review",
      tokensSaved: 123,
      reasons: ["compress PR body"],
    },
  ],
  artifacts: [
    ...(m1.artifacts ?? []),
    { kind: "review", path: `.otto/runs/${res1.runId}/review.md` },
  ],
};
writeManifest(fx.workspaceDir, seeded);
```

Run the resumed pre-aborted invocation with `agentId: "codex"`, then assert:

```ts
const m2 = readManifest(fx.workspaceDir, res2.runId);
expect(m2.startedAt).toBe(seeded.startedAt);
expect(m2.runtime).toEqual(seeded.runtime);
expect(m2.toolsUsed).toEqual(seeded.toolsUsed);
expect(m2.artifacts).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      kind: "review",
      path: `.otto/runs/${res1.runId}/review.md`,
    }),
  ])
);
expect(m2.costUsd).toBe(seeded.costUsd);
expect(res2.costUsd).toBe(0);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test -t "RESUMED run pre-aborted"
```

Expected: FAIL because the resumed finalizer currently replaces runtime/start/tools/artifacts with current-only values.

- [ ] **Step 3: Merge the prior manifest deterministically**

Read the prior manifest once:

```ts
const priorManifest = resumedAnalysis
  ? readManifest(workspaceDir, runId)
  : null;
const priorManifestCost = priorManifest?.costUsd ?? 0;
const priorManifestUsage = priorManifest?.tokenUsage ?? emptyTokenUsage();
```

Add local deterministic mergers:

```ts
const mergeArtifacts = (
  prior: RunArtifact[] = [],
  current: RunArtifact[] = []
): RunArtifact[] => {
  const merged = new Map<string, RunArtifact>();
  for (const artifact of [...prior, ...current]) {
    merged.set(`${artifact.kind}\0${artifact.path}`, artifact);
  }
  return [...merged.values()];
};

const mergeTools = (
  prior: ToolUsage[] = [],
  current: ToolUsage[] = []
): ToolUsage[] => {
  const merged = new Map<string, ToolUsage>();
  for (const usage of [...prior, ...current]) {
    merged.set(JSON.stringify(usage), usage);
  }
  return [...merged.values()];
};
```

Build final manifests from the historical base, overriding only advancing fields:

```ts
const toolsUsed = mergeTools(priorManifest?.toolsUsed, runToolsUsed);
const manifest: RunManifest = {
  ...(priorManifest ?? {}),
  runId,
  bin: "otto-review",
  mode: "github-pr-review",
  inputs: `${repository}#${pullRequest}`,
  runtime: priorManifest?.runtime ?? {
    id: activeAgentId,
    displayName: activeAgentId,
  },
  iterations: priorManifest?.iterations ?? 1,
  completedIterations: Math.max(priorManifest?.completedIterations ?? 0, 1),
  costUsd: priorManifestCost + manifestCost,
  tokenUsage: addTokenUsage(priorManifestUsage, manifestUsage),
  exitReason,
  artifacts: mergeArtifacts(priorManifest?.artifacts, artifacts),
  ...(toolsUsed.length ? { toolsUsed } : { toolsUsed: undefined }),
  pullRequestReview: evidence,
  startedAt: priorManifest?.startedAt ?? startedAt,
  finishedAt: deps.now().toISOString(),
};
```

If TypeScript rejects `toolsUsed: undefined`, construct the manifest without that property and assign `manifest.toolsUsed = toolsUsed` only when non-empty. Do not alter the returned per-invocation `costUsd`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @phamvuhoang/otto-core test -- pr-review-pipeline.test pr-review-publish.test run-report.test inspect.test
pnpm --filter @phamvuhoang/otto-core typecheck
```

Expected: all named tests PASS; the resumed manifest retains original provenance and the returned resume cost remains zero.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/core/src/pr-review.ts packages/core/src/__tests__/pr-review-pipeline.test.ts
git commit -m "fix(p32): preserve manifest provenance on resume"
```

---

### Task 4: Synchronize P32 documentation and run the release gate

**Files:**

- Modify: `docs/superpowers/specs/2026-07-18-automated-pr-code-review-design.md:425-432,605-645,739-744,798-807`
- Modify: `docs/superpowers/plans/2026-07-18-automated-pr-code-review.md:15-21,1572-1650`
- Modify: `scripts/review-cli-docs.test.mjs`

**Interfaces:**

- Consumes: the approved hardening design and shipped `ReviewLease`/`PullRequestReviewEvidence` types.
- Produces: source-of-truth documentation using OS-flock lease terminology, `artifactPath: string | null`, and valid Markdown fences.

- [ ] **Step 1: Add failing documentation-contract assertions**

In `scripts/review-cli-docs.test.mjs`, load the P32 spec and plan and add:

`````js
const p32Spec = readFileSync(
  join(
    root,
    "docs",
    "superpowers",
    "specs",
    "2026-07-18-automated-pr-code-review-design.md"
  ),
  "utf8"
);
const p32Plan = readFileSync(
  join(
    root,
    "docs",
    "superpowers",
    "plans",
    "2026-07-18-automated-pr-code-review.md"
  ),
  "utf8"
);

test("P32 source documents use the shipped OS-flock lease contract", () => {
  assert.doesNotMatch(p32Spec, /atomically claim the|atomic claims/);
  assert.doesNotMatch(p32Plan, /state, claims, evidence/);
  assert.match(p32Spec, /artifactPath: string \| null/);
  assert.doesNotMatch(p32Plan, /````ts/);
  assert.match(p32Plan, /```ts\nexport type PullRequestReviewOutputState/);
});
`````

- [ ] **Step 2: Run the root documentation test and verify RED**

Run:

```bash
node --test scripts/review-cli-docs.test.mjs
```

Expected: FAIL on the obsolete claim wording, evidence type, and four-backtick fence.

- [ ] **Step 3: Correct the source documents**

Make these exact semantic updates:

- “atomically claim the composite identity” → “acquire the composite identity's OS-flock lease”;
- “atomic claims” → “atomic OS-flock leases”;
- “state, claims, evidence” → “state, lease identity, evidence”;
- `PullRequestReviewEvidence.reviewInput.artifactPath: string` → `string | null` with prose explaining that `null` means the exact artifact could not be durably materialized;
- change the Task 11 outer ```ts fence to a normal ` ``ts `fence closed immediately after`PullRequestReviewState`, render the supersession paragraph as prose, then open a separate normal TypeScript fence for `ReviewLease`.

- [ ] **Step 4: Verify docs and the complete release gate**

Run each command separately and require exit code 0:

```bash
node --test scripts/review-cli-docs.test.mjs
pnpm -r typecheck
pnpm -r test
pnpm test
pnpm -r build
node scripts/smoke-pack-install.mjs
git diff --check 5360b87..HEAD
```

Expected: documentation test passes; core reports all tests passing except the four intentional skips; root reports zero failures; build and installed-package smoke pass with zero GitHub writes; diff check is clean.

- [ ] **Step 5: Commit Task 4**

```bash
git add docs/superpowers/specs/2026-07-18-automated-pr-code-review-design.md docs/superpowers/plans/2026-07-18-automated-pr-code-review.md scripts/review-cli-docs.test.mjs
git commit -m "docs(p32): align evidence and lease contracts"
```

---

## Final review checkpoint

- [ ] Request an independent adversarial review of the implementation range beginning after the design/plan commits.
- [ ] Reconcile every Critical/Important finding against source and focused tests.
- [ ] Re-run any affected focused test after review fixes.
- [ ] Re-run the full verification commands before reporting completion.
