# Design: Automated pull-request code review (P32)

Date: 2026-07-18
Status: Approved, including review-input amendment
Roadmap: Proposed urgent P32, parallel to Phase 6
Primary user story: CR-001

## Summary

Otto can implement GitHub issues, watch labelled issue queues, review its own
latest implementation commit, run a specialist review panel, validate external
review documents, and inject governed review skills. It cannot yet watch a
GitHub repository for pull requests, review an immutable PR revision without
modifying it, or publish an idempotent review back to the PR.

P32 adds a dedicated `otto-review` command. It watches one explicitly scoped
GitHub repository for open, non-draft PRs carrying a configurable label,
reviews each unseen head SHA in an isolated worktree using a built-in or
explicitly selected validated review skill, and optionally evaluates the change
against one operator-supplied review input: a same-repository GitHub spec issue,
a local text/Markdown file, or a direct prompt. It renders the same structured
result as terminal text, a Markdown artifact, or an upserted GitHub comment. An
explicit `--github-review` option additionally submits one formal GitHub review
per PR head SHA and review-input fingerprint with inline findings and an
approve/comment/request-changes verdict.

The workflow is read-only with respect to the contributor's branch. The model
receives no GitHub credentials or network access. Only harness-owned code may
read from or publish to GitHub, and all publication is reconciled by stable
markers before it is attempted.

## Roadmap and implementation grounding

This design was checked against the current roadmaps, code, and recent branch
history rather than treating roadmap status text as the only source of truth.

- **Phase 1, P0-P6:** shipped foundations for typed trajectories, evaluation,
  adaptive routing, governed memory, safety/taint, skills, and operator views.
- **Phase 2, P7-P12:** shipped context telemetry, spec/plan authoring,
  human-legible reports, live views, model/sub-agent orchestration, and the
  governed journal.
- **Phase 3, P13-P15:** shipped semantic plan-depth checks, structural review,
  severity-ranked findings, adversarial verification, and outcome-first
  reports.
- **Phase 4, P16-P21:** shipped external skill import/validation/activation,
  tool authority, Headroom integration, and extension profiles.
- **Phase 5, P22-P24:** the roadmap records the core context-lifecycle, input
  sharpening, and artifact-verification slices as landed. The current feature
  branch also contains P25/P26 implementation commits for fan-out coordination
  and Codebase Memory; those are reusable when integrated but are not a
  prerequisite for P32.
- **Phase 6, P27-P31:** remains planned. Its designs strengthen P32 later:
  P27 can add harness-attested checks, P28 can add recurring-finding signals,
  and P29/P30 can reduce large-review prompt cost. None blocks the urgent first
  P32 slice.

Relevant shipped code:

- `watch.ts` polls labelled GitHub/Linear issues, distinguishes idle from a
  failed poll, and supplies keep-alive, budget, notification, and shutdown
  patterns. Its `PollResult` is count-only and issue-specific, so P32 reuses
  those operational patterns rather than forcing PR identity into that type.
- `panel.ts` runs concurrent read-only lenses, deduplicates structured
  findings, adversarially verifies them, and then runs a mutating synth stage.
  P32 needs the analysis half without synth.
- `review-severity.ts` supplies the canonical severity and finding shapes.
- `skill-activation.ts`, `skill-routing.ts`, and `skill-validation.ts` supply
  validation, stage scope, drift detection, bounded excerpts, attribution, and
  evidence.
- `run-report.ts`, `report-finalize.ts`, and `inspect.ts` supply durable run
  evidence and operator rendering.
- `risk.ts` and `model-tier.ts` supply change-risk classification, lens
  selection, and per-stage/per-lens model routing.
- `taint.ts` and `safety-policy.ts` supply untrusted-input fencing and
  repo-local policy enforcement.

The existing `reviewer` stage is not reusable as the P32 entry point: it reviews
only `HEAD` and is explicitly allowed to edit and create `fix(review):`
commits. P32 requires a dedicated read-only entry workflow.

## User story CR-001

- **Summary:** Automatically review labelled pull-request revisions so
  maintainers receive consistent feedback without manually starting reviews.

### Use Case

- **As a** repository maintainer responsible for pull-request quality
- **I want to** have Otto watch for labelled PRs and review every new head
  revision using an approved code-review skill and an optional explicit spec,
  file, or prompt
- **so that** contributors receive timely, evidence-backed feedback while I
  retain control over review policy and publication.

### Acceptance Criteria

- **Scenario:** Otto reviews an unseen revision of a labelled pull request.
- **Given:** `otto-review` is watching an authenticated, explicitly scoped
  GitHub repository.
- **and Given:** An open, non-draft PR carries the configured review label.
- **and Given:** Its current head SHA has not been successfully reviewed by
  Otto against the current review-input fingerprint.
- **and Given:** The built-in review skill or configured override is eligible
  for the review stage.
- **and Given:** Zero or one review input is configured as a same-repository
  GitHub issue, workspace-contained text/Markdown file, or direct prompt.
- **and Given:** The output mode is `text`, `markdown`, or `comment`.
- **When:** The next poll discovers that PR revision.
- **Then:** Otto snapshots the exact review input, performs one read-only,
  evidence-backed review, emits it through the configured output, records the
  repository/PR/head-SHA/input-fingerprint result, and does not process that
  composite identity again.

## Product contract

### CLI

P32 adds a dedicated bin:

```text
otto-review --repo owner/name --pr 123 [options]
otto-review --repo owner/name --watch [options]
```

Exactly one of `--pr` or `--watch` is required.

P32-specific options:

```text
--repo <owner/name>              Explicit GitHub repository scope
--pr <number|URL>                Review one pull request revision
--watch                          Poll the labelled PR queue continuously
--watch-interval <seconds>       Poll interval; default 300
--label <name>                   Eligibility label; default "otto-review"
--review-skill <name>            Exact validated repo skill override
--spec-issue <number|URL>        Same-repository GitHub issue used as review intent
--spec-file <path>               Workspace-contained UTF-8 .txt/.md/.markdown intent
--prompt <text>                  Direct non-empty review intent
--output <text|markdown|comment> Primary output mode
--output-file <path>             Copy the canonical Markdown output
--github-review                  Also submit a formal GitHub review
```

Configuration/env equivalents:

- `OTTO_REVIEW_LABEL` for the label.
- `OTTO_REVIEW_SKILL` for the skill override.
- `OTTO_REVIEW_OUTPUT` for the primary output.
- `.otto/config.json` `pullRequestReview` with `label`, `skill`, `output`, and
  `githubReview` fields.

The three review-input flags are per-invocation inputs, not persistent
environment/config fields. Zero or exactly one of `--spec-issue`,
`--spec-file`, and `--prompt` is accepted. With none, Otto reviews against the
PR description, exact diff, and repository context only. Watch mode applies
the selected source to every discovered PR and resolves a fresh immutable
snapshot for each run. Operators should prefer `--spec-file` over `--prompt`
for sensitive or long-lived text because command-line arguments may be visible
to other local processes; every selected input is retained in run evidence and
must not contain secrets.

Precedence follows Otto conventions: flag, then env, then repo config, then
default. One-shot mode defaults to `text`; watch mode defaults to `comment`.
`--output-file` is valid only with `--output markdown`. `--github-review` is an
additional output and does not silently enable summary-comment output.

The bin also supports Otto's existing runtime controls where they apply:
`--agent`, fallback-on-limit, model routing, token mode, context compressor,
budget, cooldown, retries, detach, notification, verbose output, and
`--print-config`. Fan-out, plan, verify, apply-review, issue, and branch-writing
modes do not apply.

### Repository and label scope

The target workspace must be a local checkout of `--repo`; preflight compares
the canonical GitHub origin with the explicit repository scope. A mismatch
fails before polling or model execution. Multi-repository watch and implicit
cloning are out of scope for v1.

The eligibility label defaults to `otto-review`. Preflight verifies that the
label exists. Otto never adds or removes the label. A PR is eligible only when
it is open, non-draft, carries the exact configured label, and has a head SHA
whose current input fingerprint is not already successful.

### Review input

Review input supplies acceptance criteria and review intent; it never grants
tool, filesystem, network, or publication authority. The P32 safety contract,
trusted base-revision repository instructions, and operator-workspace policy
remain higher priority. Issue, file, and prompt content is taint-fenced before
model use because it may contain copied contributor instructions.

- `--spec-issue <number|URL>` accepts a positive issue number or a
  `https://github.com/<owner>/<repo>/issues/<number>` URL whose lower-cased
  owner/repository exactly matches `--repo`. Otto reads `number`, `url`,
  `title`, `body`, `state`, and `updatedAt` through its typed GitHub adapter.
  Open and closed issues are both valid; a pull-request URL or cross-repository
  issue is rejected.
- `--spec-file <path>` resolves from the operator workspace, must remain beneath
  that workspace after `realpath`, and must be a non-symlink regular file with
  a case-insensitive `.txt`, `.md`, or `.markdown` extension. The file must be
  non-empty valid UTF-8. Path traversal, special files, symlinks, and invalid
  encoding fail before a model call.
- `--prompt <text>` trims only for emptiness validation; the exact supplied
  UTF-8 string is otherwise retained. Empty/whitespace-only prompts fail.
- No input produces a deterministic `none` snapshot and keeps current PR-only
  review behavior.

Every source becomes a `ReviewInputSnapshot`. Its fingerprint is lower-case
SHA-256 over the UTF-8 bytes of `kind + "\0" + canonical locator + "\0" +
exact content`. The issue locator is its canonical same-repository URL; the
file locator is its normalized workspace-relative POSIX path; prompt and none
use fixed locators `direct` and `none`. Issue content is its exact title, two
newlines, and exact body; none uses empty content. The deterministic artifact
contains `kind`, `source`, and `fingerprint` headers followed by an
`Untrusted review intent` heading and the exact content without line-ending
normalization. It is retained at `.otto/runs/<run-id>/review-input.md`, copied
byte-for-byte into the disposable worktree for bounded reads, and never passed
through the context compressor. The stage contract treats the entire intent
section as data even when its content contains Markdown headings or apparent
agent instructions.

In watch mode, Otto resolves the selected source before choosing runnable work
on each poll. This lets an edited issue/file or changed daemon prompt produce a
new fingerprint and therefore new work. A source-resolution failure is a poll
failure, not an empty queue and not a processed PR.

### Review identity and repeat behavior

The immutable work identity is:

```text
(repository owner/name, pull-request number, head SHA, review-input fingerprint)
```

The same composite identity is reviewed once. A new head SHA or changed input
fingerprint is new work and updates the existing Otto summary comment when
comment output is selected. Closing the PR, converting it to draft, or removing
the label makes it ineligible. Re-adding the label does not re-review an already
successful composite identity; a new SHA or input fingerprint does.

### Review skills

The default is `builtin:otto-code-review`, a template-owned review profile
using the existing `correctness`, `security`, `tests`, `structural`, and
`task-fit` lenses plus adversarial verification.

`--review-skill <name>` selects exactly one repo skill from `.otto/skills/`.
The override is eligible only when:

- its recorded compatibility is `afk-safe`, or `stage-scoped` including
  `review`;
- it is not `interactive-only` or `blocked`;
- its instructions checksum still matches validation;
- its risk constraints admit the PR's changed paths; and
- its bounded excerpt fits the existing review-stage skill budget.

An invalid, stale, missing, or ineligible selected skill fails before a paid
model call. P32 does not silently fall back to the built-in profile when the
operator explicitly selected a skill. Skill source/ref/checksum and selection
reason are recorded in `skillsUsed[]`.

## Architecture

### Component boundaries

1. **Review CLI/main** parses P32 arguments, resolves config, runs preflight,
   and selects one-shot or watch orchestration.
2. **GitHub PR adapter** owns every `gh` invocation and converts output/errors
   into typed PR/issue metadata, publication results, and retry classifications.
3. **Review-input resolver** validates the exclusive source, snapshots exact
   content, computes its fingerprint, and writes the retrievable input artifact.
4. **Revision state store** provides an atomic local OS-flock lease (a
   persistent per-composite-identity lock file, kernel-released the instant
   its holder dies), partial-output recovery, and success identity.
5. **PR worktree manager** fetches exact base/head refs and creates a detached,
   disposable checkout without switching the operator's working tree.
6. **Review analysis** runs lenses and adversarial verification, returning
   structured confirmed/rejected findings without a synth/fix stage.
7. **Review renderer** creates one canonical Markdown document and derives the
   terminal form and GitHub bodies from it.
8. **Publisher** writes local output, upserts the summary comment, and
   optionally creates the formal review after remote reconciliation.
9. **Evidence integration** records PR/input identity, skills, stages, findings,
   output receipts, supersession/cancellation, and final outcome.

### Typed PR contract

```ts
export type PullRequestRevision = {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  labels: string[];
  baseRefName: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
};
```

The GitHub adapter invokes `gh` with literal argv through `execFile`/`execFileSync`,
never a shell. The adapter fetches metadata; local `git diff
<baseSha>...<headSha>` is authoritative for the review patch.

The same adapter resolves a spec issue through this literal contract and rejects
any missing or malformed field:

```text
gh issue view N --repo owner/repo --json number,url,title,body,state,updatedAt
```

### Typed review-input contract

```ts
export type ReviewInputRequest =
  | { kind: "none" }
  | { kind: "github-issue"; ref: string }
  | { kind: "local-file"; path: string }
  | { kind: "prompt"; text: string };

export type ReviewInputSnapshot = {
  kind: ReviewInputRequest["kind"];
  source: string;
  fingerprint: string;
  content: string;
  artifactPath: string;
};
```

`source` is the canonical issue URL, workspace-relative POSIX file path,
`direct`, or `none`. `artifactPath` is workspace-relative and points exactly to
`.otto/runs/<run-id>/review-input.md`. The snapshot parser verifies kind,
source, 64-character fingerprint, exact artifact path, and content hash before
resuming analysis or publication.

### Exact checkout

For PR number `N`, the worktree manager:

1. Fetches the current base ref and `refs/pull/N/head` into Otto-owned temporary
   refs.
2. Verifies the fetched object IDs equal the adapter's `baseSha` and `headSha`.
3. Creates a detached worktree at `headSha` under
   `.otto-tmp/pr-review-worktrees/<run-id>/`.
4. Writes the exact `baseSha...headSha` patch as a retrievable run artifact.
5. Removes the worktree and temporary refs after processing.

The operator's checkout and current branch never change. Fork PRs use GitHub's
pull ref and do not require adding the contributor's fork as a remote.

### Review-panel reuse

`panel.ts` is refactored around a reusable read-only operation:

```ts
export type ReviewAnalysisResult = {
  confirmed: Finding[];
  rejected: Finding[];
  severity: {
    blocker: number;
    major: number;
    minor: number;
    nit: number;
    suppressed: number;
  };
  stageResults: StageResult[];
};

export async function analyzeReview(
  opts: ReviewAnalysisOptions
): Promise<ReviewAnalysisResult>;
```

Existing `runPanel` calls `analyzeReview` and, when confirmed findings exist,
continues into its current synth/fix stage. P32 calls only `analyzeReview`.
Existing review behavior, stage evidence ordering, budget handling, lens
parallelism, and CONFIRMED-only synth semantics remain unchanged.

P32 uses a dedicated `pr-review` stage family/name for routing and evidence.
The stage receives taint-fenced PR context, changed paths, the exact diff
artifact, the exact review-input artifact, trusted base-revision repo
instructions, and the selected skill excerpt. It does not receive publication
authority.

### Structured result and outcome

The canonical published finding extends the existing `Finding` with verified
line placement:

```ts
export type PublishedReviewFinding = Finding & {
  side?: "LEFT" | "RIGHT";
  mappedLine?: number;
  inlineEligible: boolean;
};

export type PullRequestReviewOutcome =
  | "changes-requested"
  | "comment"
  | "approved";
```

Only adversarially confirmed findings are published. Outcome is deterministic:

- any blocker or major: `changes-requested`;
- only minor/nit findings: `comment`;
- no confirmed findings: `approved`.

Summary-comment mode reports this outcome but does not change GitHub's formal
review state. `--github-review` maps it to `REQUEST_CHANGES`, `COMMENT`, or
`APPROVE` respectively.

Inline comments require a path and line present in the exact PR diff. A local
zero-context diff map determines GitHub `LEFT`/`RIGHT` placement. Binary,
whole-file, deleted-without-mappable-line, or otherwise unmappable findings
remain in the formal review body; they are never dropped or assigned a guessed
line.

## Data flow

For each eligible revision:

1. Resolve and validate the selected review-input source without a model call.
2. Compute its fingerprint and allocate a run ID, restoring the persisted ID for
   a resumed composite identity.
3. Acquire the repository/PR/head-SHA/input-fingerprint identity's OS-flock lease
   using that run ID.
4. Write the exact input artifact and initialize evidence.
5. Resolve and validate the exact review skill.
6. Fetch the exact base/head objects and create the detached worktree.
7. Build the taint-fenced PR context, exact diff, and byte-identical worktree
   copy of the review-input artifact.
8. Run read-only lenses, deduplicate findings, and adversarially verify them.
9. Persist the structured analysis and canonical Markdown before publication.
10. Re-query GitHub for state, draft flag, label, and head SHA.
11. If still eligible and unchanged, reconcile then publish configured outputs.
12. Record output receipts and mark the composite identity successful.
13. Finalize the run report and remove disposable worktree state.

Watch mode handles one PR at a time. After a completed item it immediately
re-polls until no eligible unseen revision remains, then sleeps for the
configured interval. Budget, cooldown, notification, shutdown, and
fallback-on-limit apply across the daemon lifetime.

## State, locking, and idempotency

Local state is stored per immutable revision under the gitignored
`.otto/review-state/github/<owner>/<repo>/<pr>/<head-sha>/<input-fingerprint>.json`.
Keeping one record per composite identity preserves review history when a PR
advances, force-pushes back to an earlier SHA, or is reviewed against changed
intent:

```ts
export type PullRequestReviewState = {
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  status:
    | "running"
    | "analysis-failed"
    | "publish-failed"
    | "succeeded"
    | "superseded"
    | "cancelled";
  runId: string;
  analysisArtifact?: string;
  outputs: {
    text?: { status: "succeeded" };
    markdown?: { status: "succeeded"; path: string };
    comment?: { status: "succeeded"; commentId: number };
    githubReview?: { status: "succeeded"; reviewId: number };
  };
  attempts: number;
  retryable?: boolean;
  nextRetryAt?: string;
  error?: string;
  updatedAt: string;
};
```

**Superseded:** an earlier revision of this design specified a
`PullRequestReviewClaim` file with `pid`/`acquiredAt`/`heartbeatAt` fields, a
60-second heartbeat, and a 15-minute stale-timeout takeover. The shipped
mechanism instead acquires the lease as a real OS advisory lock (`flock`) held
on a persistent per-composite-identity lock file
(`<state-path>.lock`, a stable inode) via the optional native `fs-ext`
dependency (loaded lazily — only an actual `otto-review` run needs it; `--help`,
`--print-config`, and every other command are unaffected, though building the
native addon requires a C/C++ toolchain). Acquisition opens the lock file and
takes a non-blocking exclusive flock; a second acquirer gets `EAGAIN`/
`EWOULDBLOCK` and reports busy. There is no PID field, no heartbeat, and no
tombstone: the kernel releases the flock the instant the holding file
descriptor closes or the holding process dies, so a crashed or killed daemon's
lock is freed automatically and a restart's exclusive flock simply succeeds.
Release drops the flock and closes the fd; the lock file itself is left in
place so future acquirers keep contending on the same inode. A live lease
prevents two daemon processes on the same workspace from reviewing the same
composite identity concurrently, and is scoped to one active daemon per
repository. The lock requires a LOCAL filesystem — advisory `flock` is
unreliable or unsupported over some network filesystems (e.g. NFS). Remote
publication markers reconcile crashes, restarts, and lost local state;
simultaneous daemons on different machines are not a supported coordination
mode in v1.

The summary comment contains a stable marker scoped to repository and PR:

```html
<!-- otto-review:owner/name#123 -->
```

It is created once and updated for later composite identities. Its body also
carries exact head and input markers so lost local state can be reconciled
without treating an older comment as proof that the current review ran:

```html
<!-- otto-review-head:<head-sha> -->
<!-- otto-review-input:<input-fingerprint> -->
```

A formal review contains one immutable composite marker:

```html
<!-- otto-review:owner/name#123@<head-sha>:<input-fingerprint> -->
```

Before creating a comment or review, the publisher queries existing remote
objects for the composite marker. Retries update/reuse the existing object. A
partially published composite identity reuses `analysisArtifact` and retries
only missing outputs; it does not repay for model analysis.

Permanent publication errors, including GitHub refusing self-approval, set
`retryable: false` and remain visible in the run report. Transient errors use
bounded retry/backoff and `nextRetryAt`. A new head SHA or review-input
fingerprint is independent of the prior permanent failure.

**Final-audit remediation addendum (`996ef32`, see
`docs/superpowers/plans/2026-07-19-pr-review-final-audit-remediation.md`):**
the design above shipped with the composite lease as the ONLY lock guarding
the shared summary comment. The final-audit remediation added a SECOND,
PR-scoped publication lock (`acquirePublicationLease`, a persistent
stable-inode `flock` on `.otto/review-state/github/<owner>/<repo>/<pr>/publication.lock`,
keyed only by repository/PR — the same file for every head SHA and input
fingerprint of that PR) because two DIFFERENT composite identities (distinct
input fingerprints on the same PR) each hold an independent composite lease
and can legitimately race to list/create/update the ONE shared summary
comment. Acquisition order is fixed and global — composite lease FIRST
(non-blocking; a busy identity is `skipped`), publication lease SECOND
(BLOCKING; the second publisher waits for the first), and the publication
lease is released immediately after that reconcile/write, never held across
the independent `--github-review` formal-review write — so the two locks can
never deadlock. The same remediation also made three other changes to this
contract: (1) `readReviewAnalysisArtifact` and the remote-body envelope
parsers strictly validate identity/schema/marker-position/diff-SHA-256/path
integrity before ANY resume or lost-state recovery trusts persisted or remote
evidence — invalid evidence is treated as absent and a fresh analysis runs,
never trust-and-publish; (2) a prior `succeeded` state is terminal only when
EVERY sink the CURRENT invocation requests already has a receipt (not merely
"missing outputs" in the abstract) — a success missing a now-requested sink
(e.g. a prior `--output text` run re-invoked with `--github-review`) resumes
just that sink from validated analysis at zero additional model cost; and
(3) `writeReviewState` is fail-closed — a durable-persistence failure raises
`ReviewStatePersistenceError` instead of being swallowed, so a run never
reports `succeeded` when its terminal state was not durably persisted, and
`--watch` treats that error (plus a non-busy `ReviewLeaseError`, e.g. a
missing/broken `fs-ext` or `ENOTSUP`) as fatal: attempt once, notify, exit —
never spin forever. `--watch` also now runs the identical viewer/auth +
exact-label + origin/repository preflight described above for one-shot
BEFORE it starts polling, not per-poll.

## Safety and trust boundaries

- PR title, body, diff, changed source, and selected review-input content are
  untrusted inputs. The taint taxonomy gains pull-request and review-input
  sources, and the prompt carries the canonical do-not-obey warning.
  Instructions embedded in code, PR prose, issues, files, or direct prompts do
  not outrank repo instructions, the review contract, or policy.
- GitHub metadata/diff retrieval completes before model execution. Review-stage
  child processes receive no `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, Git
  credential-helper access, or GitHub network access.
- All GitHub reads/writes after model execution are harness-owned typed adapter
  calls. The model never emits a command that the harness executes as a
  publication instruction.
- The disposable worktree starts clean. HEAD, tracked status, and untracked
  source paths are checked after every read-only stage. Any mutation is a
  contract violation: analysis fails, the mutation is discarded with the
  worktree, and nothing is published.
- The exact diff and exact review-input snapshot are never lossy-compressed.
  Large artifacts remain retrievable and are read in bounded chunks.
- A missing or malformed verifier verdict does not mean clean. The run fails
  analysis and publishes nothing.
- The selected skill is advisory context beneath repo instructions, stage
  contracts, and `.otto/policy.json`.
- P32 never edits source, commits, pushes, merges, closes a PR, or changes
  labels.

## Publication contract

One canonical Markdown artifact is always retained in
`.otto/runs/<run-id>/review.md`, including when primary output is `text` or
`comment`. It contains:

1. PR identity, exact head SHA, review-input kind/source/fingerprint.
2. Outcome and confirmed severity counts.
3. Confirmed findings ordered by severity.
4. Rejected/suppressed counts without publishing rejected claims as defects.
5. Review skill attribution.
6. Diff, input, analysis, and review evidence paths plus review limitations.
7. Reproduction/run ID.

Output behavior:

- `text`: render a concise terminal form from the canonical result.
- `markdown`: retain the canonical artifact and atomically copy it to
  `--output-file` when provided.
- `comment`: create or update the marker-owned summary comment.
- `--github-review`: additionally submit one marker-owned formal review for the
  head-SHA/input-fingerprint identity; inline only validated mappings.

The publisher re-queries the PR immediately before all remote writes. If the PR
closed, became draft, lost the label, or changed head SHA, the run becomes
`cancelled` or `superseded` and emits no remote output. Local text/Markdown may
remain as run evidence but is labelled stale and is not marked successful for
that composite identity. The snapshotted review input remains authoritative for
an in-flight run; an issue/file edit is discovered by the next watch poll and
creates a new input fingerprint rather than invalidating a completed analysis.

## Error handling

- **Preflight:** missing `gh`, unauthenticated GitHub, absent label, origin/repo
  mismatch, missing read access, invalid config/input selection, or ineligible
  skill stops before a model call.
- **Review input:** cross-repository/missing/malformed issue, file escape,
  symlink/special file, unsupported extension, invalid UTF-8, missing file, or
  empty input fails before lease acquisition or a paid model call. Watch reports
  resolution failure distinctly and retries on a later poll.
- **Polling:** empty queue and poll failure are distinct. Auth/permission errors
  are actionable; rate limits and transient transport failures use existing
  bounded backoff and never mark a revision processed.
- **Fetch/worktree:** object mismatch, missing pull ref, or worktree failure
  records `analysis-failed`, cleans up what it can, and publishes nothing.
- **Analysis:** model errors, malformed findings/verdicts, budget exhaustion, or
  read-only violations publish nothing. Transient model/runtime failures may
  retry under the configured stage retry budget.
- **Publication:** each output has an independent receipt. Successful outputs
  are not repeated; missing outputs resume from the persisted analysis.
- **Cleanup:** cleanup failure is recorded and surfaced but does not reverse a
  successfully published review.
- **Shutdown:** the active run receives the abort signal, finalizes evidence,
  releases its lease, and the daemon releases keep-alive resources.

## Evidence model

The run mode is `github-pr-review`. The manifest gains an optional P32 block:

```ts
export type PullRequestReviewEvidence = {
  repository: string;
  pullRequest: number;
  url: string;
  baseSha: string;
  headSha: string;
  label: string;
  reviewInput: {
    kind: ReviewInputRequest["kind"];
    source: string;
    fingerprint: string;
    artifactPath: string | null;
  };
  outcome?: PullRequestReviewOutcome;
  confirmed: number;
  rejected: number;
  outputMode: "text" | "markdown" | "comment";
  githubReview: boolean;
  commentId?: number;
  reviewId?: number;
  supersededBy?: string;
};
```

`reviewInput.artifactPath` names the durable exact-input artifact when it was
successfully materialized. `null` means the exact artifact could not be durably
materialized and is therefore unavailable for retry or recovery.

Existing stage records carry lens/verifier results, model routing, token/cost,
skill usage, safety events, and artifacts. `otto-inspect` and `otto-explain`
render the PR identity, exact SHA, review-input provenance/fingerprint, outcome,
publication receipts, and any stale or failed state.

## Testing strategy

### Pure unit tests

- CLI/config precedence and invalid combinations.
- Mutual exclusion and parsing for issue/file/prompt inputs.
- Same-repository issue references, workspace-contained UTF-8 file validation,
  exact prompt preservation, deterministic snapshots, and fingerprints.
- PR eligibility for label, state, draft, and successful SHA.
- State transitions and atomic OS-flock lease acquisition/release, including
  automatic crash recovery (no heartbeat or stale-timeout takeover).
- Outcome derivation from confirmed severities.
- Comment/formal-review marker generation and matching.
- Diff-side/line mapping for added, modified, deleted, binary, and unmappable
  findings.
- Markdown and text rendering from the same structured result.

### GitHub adapter contract tests

An injected command runner prevents live GitHub calls in CI. Tests cover:

- literal argv construction with no shell interpolation;
- authentication, permission, rate-limit, network, and malformed-JSON errors;
- exact issue metadata parsing and same-repository URL validation;
- open/non-draft/label filtering and exact head/base metadata;
- summary comment create versus update;
- formal review reconciliation by head-SHA/input-fingerprint marker; and
- fork PR pull-ref handling.

### Pipeline integration tests

Temporary local repositories plus mocked GitHub/stage adapters prove:

- one successful review per labelled head-SHA/input-fingerprint identity;
- automatic re-review on a new head SHA or changed input fingerprint;
- no-input, same-repository issue, local file, and direct prompt snapshots reach
  every lens/verifier through the exact artifact path;
- input resolution failure occurs before lease acquisition, worktree creation,
  or model execution;
- no stale publication after head, label, draft, or state changes;
- invalid selected skill fails before model execution;
- model mutations are detected and discarded;
- partial publication retries only missing outputs;
- restart does not duplicate comments/formal reviews;
- verified findings map to output deterministically; and
- existing `runPanel` still synthesizes fixes while P32 never invokes synth.

### Harness evaluation fixtures

- PR with a real correctness defect.
- Clean PR with zero confirmed findings.
- Duplicate findings from multiple lenses.
- False positive rejected by adversarial verification.
- Prompt injection in PR prose and changed source.
- Prompt injection in spec issue, local file, and direct prompt content.
- Same-head review rerun after review-input content changes.
- Large multi-file PR with retrievable full diff.
- Inline candidates covering both diff sides and unmappable locations.

### Completion commands

```bash
pnpm -r typecheck
pnpm -r test
pnpm test
```

A package smoke test also verifies installed `otto-review --help`,
`--print-config`, one-shot text mode, and watch config without performing a
live GitHub write.

## Delivery slices

### Slice 1: Read-only one-shot review

- `otto-review --repo ... --pr ...`.
- Exact isolated checkout and diff.
- Optional GitHub issue, local file, or direct prompt review input with exact
  artifact/fingerprint evidence.
- Built-in or explicit validated skill.
- Read-only analysis with no synth.
- Canonical evidence, `text`, and `markdown` output.
- No GitHub writes.

### Slice 2: Watch and idempotent summary comment

- Labelled PR polling.
- Per-poll review-input resolution plus composite-identity state, atomic
  OS-flock leases, retry scheduling, and supersession.
- Marker-owned comment create/update.
- Partial-output recovery and daemon controls.

### Slice 3: Formal GitHub review

- Opt-in `--github-review`.
- Diff-side/line validation.
- Inline confirmed findings when mappable.
- Deterministic approve/comment/request-changes verdict.
- Remote review reconciliation by head SHA and input fingerprint.

Each slice is independently useful and keeps the prior slice's defaults. P27
attested checks can extend the structured outcome later without changing the
P32 identity/publication model.

## Success criteria

- Exactly one successful review per repository/PR/head-SHA/input-fingerprint.
- Zero duplicate summary comments for a PR.
- Zero duplicate formal reviews for a composite identity under normal
  retry/restart reconciliation.
- A new head SHA or changed review input is automatically reviewed while the
  label remains.
- Zero stale-head remote publications.
- Zero contributor-branch/source mutations.
- Every published defect is adversarially confirmed and traceable to the exact
  reviewed SHA.
- Every run is reproducible from its evidence bundle.
- Watch mode without an eligible labelled PR is inert.
- Existing issue watch and implementation review behavior pass regression
  tests unchanged.

## Scope guard and non-goals

- No fixing the contributor's code or creating `fix(review):` commits.
- No push, merge, close, label mutation, or automatic suggested-code patches.
- No webhook, GitHub App, GitHub Action, hosted control plane, or CI check-run
  integration in v1.
- No multi-repository watch or implicit repository clone in v1.
- No combining multiple review-input sources and no automatic issue discovery
  from contributor-controlled PR text in v1.
- No distributed lock across simultaneous daemons on different machines; run
  one active `otto-review` daemon per repository.
- No agent-authored GitHub API or shell publication commands.
- No review of draft, closed, merged, or label-mismatched PRs.
- No requirement to wait for Phase 6; attested tests and regression signals are
  later integrations.
- No hand-editing package versions or release-please state.

## Proposed file responsibilities

The detailed implementation plan will lock exact edits after the written spec
is approved. The intended boundaries are:

| File                                               | Responsibility                                               |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `apps/cli/bin/otto-review.js`                      | Flat hand-written CLI entrypoint                             |
| `packages/core/src/review-main.ts`                 | P32 orchestration entry                                      |
| `packages/core/src/review-cli.ts`                  | P32 flags, config resolution, help, print-config             |
| `packages/core/src/github-pr.ts`                   | Typed `gh` PR/issue intake and publication adapter           |
| `packages/core/src/pr-review-input.ts`             | Review-input validation, snapshot, fingerprint, artifact     |
| `packages/core/src/pr-review-state.ts`             | Lease identity, state transitions, retry metadata            |
| `packages/core/src/pr-review-worktree.ts`          | Exact fetch, disposable worktree, mutation checks            |
| `packages/core/src/pr-review.ts`                   | Review identity, eligibility, outcome, pipeline              |
| `packages/core/src/pr-review-output.ts`            | Canonical Markdown, text, markers, diff-line mapping         |
| `packages/core/src/pr-review-watch.ts`             | Sequential queue polling and daemon lifecycle                |
| `packages/core/src/panel.ts`                       | Extract reusable `analyzeReview`; retain synth in `runPanel` |
| `packages/core/src/run-report.ts`                  | Optional P32 evidence block                                  |
| `packages/core/src/taint.ts`                       | Pull-request and review-input untrusted sources              |
| `packages/core/src/index.ts`                       | Export public P32 API/types                                  |
| `packages/core/templates/pr-review.md`             | Read-only PR review stage contract                           |
| `README.md`, `docs/CLI.md`, `docs/ARCHITECTURE.md` | User and architecture docs                                   |
| `docs/HARNESS_ROADMAP_PHASE6.md`                   | Record urgent P32 alongside, not inside, P27-P31             |

P32 adds exactly one new dependency: the optional native `fs-ext` (for the
review lease's `flock`), loaded lazily and required only for an actual
`otto-review` run — building it needs a C/C++ toolchain, but `install` and
every other command are unaffected. Core remains ESM with `.js` relative imports;
the CLI bin remains hand-written JavaScript with no build step; all new behavior
is opt-in through the new bin and inert for existing commands.
