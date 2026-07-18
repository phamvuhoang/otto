/**
 * P32 automated pull-request code review: the pure revision domain (identity,
 * eligibility, severity→outcome) plus the one-shot read-only review pipeline
 * ({@link runPullRequestReview}) that wires the resolved input, isolated worktree,
 * governed skill, read-only lens/verify analysis, structured artifact, and
 * canonical output together. Slice 1 renders text/markdown only — it holds NO
 * GitHub write capability (its `deps.github` is `getPullRequest`-only).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Finding } from "./review-severity.js";
import type { AgentRuntimeId } from "./agent-runtime.js";
import type { TierLadder } from "./model-tier.js";
import type { TokenMode, TokenUsage } from "./tokens.js";
import { addTokenUsage, emptyTokenUsage } from "./tokens.js";
import type {
  CompressorMode,
  SyncContextCompressor,
} from "./context-compressor.js";
import {
  compressContentSync,
  compressionToolUsage,
  runRetrievalStore,
} from "./context-compressor.js";
import {
  createHeadroomSyncCompressor,
  authorizeCompressor,
} from "./headroom-adapter.js";
import { readTools, readToolConfig } from "./tools.js";
import { readSafetyPolicy } from "./safety-policy.js";
import { ConsoleUi, VerboseSink } from "./console-ui.js";
import { STAGES } from "./stages.js";
import { buildReviewChildEnv, type StageResult } from "./runner.js";
import {
  analyzeReview,
  ReviewAnalysisContractError,
  type ReviewAnalysisResult,
  type ReviewSeverityCounts,
} from "./panel.js";
import { GitHubPrError, type GitHubPrClient } from "./github-pr.js";
import {
  reconcilePublication,
  upsertSummaryComment,
  nextPublicationRetryAt,
} from "./pr-review-publish.js";
import {
  readReviewState,
  writeReviewState,
  claimRevision,
  heartbeatClaim,
  releaseClaim,
  isStateRunnable,
  REVIEW_LEASE_HEARTBEAT_MS,
  type PullRequestReviewState,
  type PullRequestReviewOutputState,
  type PullRequestReviewClaim,
} from "./pr-review-state.js";
import {
  writeReviewInputArtifact,
  readReviewInputArtifact,
  type ResolvedReviewInput,
  type ReviewInputSnapshot,
} from "./pr-review-input.js";
import {
  resolveReviewSkill,
  ReviewSkillError,
  type ReviewSkillSelection,
} from "./pr-review-skill.js";
import {
  createPullRequestWorktree,
  buildReviewContext,
} from "./pr-review-worktree.js";
import {
  headMarker,
  inputMarker,
  renderCanonicalReview,
  renderReviewText,
  summaryMarker,
  writeCanonicalReview,
  type CanonicalReview,
  type PublishedReviewFinding,
} from "./pr-review-output.js";
import type { PullRequestReviewConfig } from "./review-cli.js";
import {
  allocateRunId,
  runReportDir,
  writeManifest,
  writeRunReport,
  writeStageRecord,
  type PullRequestReviewEvidence,
  type RunArtifact,
  type RunManifest,
  type SafetyEvent,
  type SkillUsage,
  type StageRecord,
  type ToolUsage,
} from "./run-report.js";

/** A snapshot of a PR at a given head commit, as fetched from GitHub. */
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

/** The review verdict, derived from the highest-severity finding present. */
export type PullRequestReviewOutcome =
  | "changes-requested"
  | "comment"
  | "approved";

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Stable key identifying a specific (revision, input) review attempt, for
 * dedup/idempotency bookkeeping: `owner/repo#number@headSha:fingerprint`.
 * `inputFingerprint` must be a 64-character lower-case hex digest (e.g. a
 * sha256 of the resolved review input); anything else throws.
 */
export function revisionKey(
  revision: Pick<PullRequestRevision, "repository" | "number" | "headSha">,
  inputFingerprint: string
): string {
  if (!FINGERPRINT_RE.test(inputFingerprint)) {
    throw new Error(
      `inputFingerprint must be a 64-character lower-case hex string, got: ${JSON.stringify(inputFingerprint)}`
    );
  }
  return `${revision.repository}#${revision.number}@${revision.headSha}:${inputFingerprint}`;
}

/**
 * Why a PR is not eligible for automated review: `null` means eligible.
 * Priority: closed/merged > draft > missing the required label.
 */
export function ineligibleReason(
  revision: PullRequestRevision,
  label: string
): "closed" | "draft" | "label-missing" | null {
  if (revision.state !== "OPEN") return "closed";
  if (revision.isDraft) return "draft";
  if (!revision.labels.includes(label)) return "label-missing";
  return null;
}

/**
 * Deterministic outcome from a set of findings: any blocker/major requests
 * changes; otherwise any minor/nit is a comment; no findings at all approves.
 */
export function outcomeForFindings(
  findings: readonly Finding[]
): PullRequestReviewOutcome {
  if (
    findings.some((f) => f.severity === "blocker" || f.severity === "major")
  ) {
    return "changes-requested";
  }
  if (findings.length > 0) return "comment";
  return "approved";
}

// ---------------------------------------------------------------------------
// One-shot read-only review pipeline (P32 Slice 1)
// ---------------------------------------------------------------------------

/** The built-in review lenses run over every PR revision, in a stable order. */
const REVIEW_LENSES = [
  "correctness",
  "security",
  "tests",
  "structural",
  "task-fit",
] as const;

/** Terminal status of one review attempt. */
export type PullRequestReviewRunStatus =
  | "succeeded"
  | "analysis-failed"
  | "publish-failed"
  | "superseded"
  | "cancelled"
  | "skipped";

/** The result of one {@link runPullRequestReview} attempt. */
export type PullRequestReviewRunResult = {
  status: PullRequestReviewRunStatus;
  runId: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
  costUsd: number;
  outcome?: PullRequestReviewOutcome;
  reviewArtifact?: string;
  /** The published summary comment id (comment output mode only). */
  commentId?: number;
  /** For a `publish-failed` result: whether a bounded retry may recover. */
  retryable?: boolean;
  /** For a retryable `publish-failed` result: the next-eligible timestamp. */
  nextRetryAt?: string;
  error?: string;
};

/**
 * The structured, schema-validated analysis persisted to
 * `.otto/runs/<run-id>/analysis.json` before any output. It carries the exact
 * reviewed identity, the confirmed/rejected findings, the severity tally, the
 * governed skill, and the diff-artifact reference so a downstream slice can
 * publish deterministically from local evidence alone.
 */
export type PullRequestReviewAnalysisArtifact = {
  schemaVersion: 1;
  repository: string;
  pullRequest: number;
  url: string;
  title: string;
  baseSha: string;
  headSha: string;
  reviewInput: Pick<
    ReviewInputSnapshot,
    "kind" | "source" | "fingerprint" | "artifactPath"
  >;
  runId: string;
  analyzedAt: string;
  outcome: PullRequestReviewOutcome;
  confirmed: PublishedReviewFinding[];
  rejected: Finding[];
  severity: ReviewAnalysisResult["severity"];
  skill: ReviewSkillSelection;
  diffArtifact: string;
};

/**
 * Read + identity-validate a persisted analysis artifact. Returns `null` when the
 * file is missing/malformed OR its recorded identity (repo/PR/head/input
 * fingerprint) does not equal the requested one, so a caller never mistakes a
 * different revision's evidence for this one.
 */
export function readReviewAnalysisArtifact(opts: {
  workspaceDir: string;
  runId: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  inputFingerprint: string;
}): PullRequestReviewAnalysisArtifact | null {
  try {
    const path = join(
      runReportDir(opts.workspaceDir, opts.runId),
      "analysis.json"
    );
    const raw = JSON.parse(
      readFileSync(path, "utf8")
    ) as PullRequestReviewAnalysisArtifact;
    if (
      raw.schemaVersion !== 1 ||
      raw.repository !== opts.repository ||
      raw.pullRequest !== opts.pullRequest ||
      raw.headSha !== opts.headSha ||
      raw.reviewInput?.fingerprint !== opts.inputFingerprint
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** Injectable seams for {@link runPullRequestReview} (tests supply fakes). */
export type PullRequestReviewDeps = {
  /**
   * The typed GitHub adapter. `getPullRequest` is always required (the
   * read-only re-query gate). The write/comment methods are consumed ONLY by
   * the harness-owned publication path when `config.output === "comment"`, so a
   * text/Markdown run can still be wired with a `getPullRequest`-only client and
   * carry no GitHub write capability at all.
   */
  github: Pick<GitHubPrClient, "getPullRequest"> &
    Partial<
      Pick<
        GitHubPrClient,
        | "viewer"
        | "listIssueComments"
        | "createIssueComment"
        | "updateIssueComment"
      >
    >;
  analyze: typeof analyzeReview;
  createWorktree: typeof createPullRequestWorktree;
  writeReviewInput: typeof writeReviewInputArtifact;
  readReviewInput: typeof readReviewInputArtifact;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  stdout: (text: string) => void;
};

/** Atomically write JSON (temp + rename) so a reader never sees a partial file. */
function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.otto-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Build the Headroom sync compressor if (and only if) mode is headroom AND the
 *  governance gate + availability allow it. Returns null otherwise (degrade
 *  clean → the PR body is used uncompressed). */
function buildReviewCompressor(
  workspaceDir: string,
  env: NodeJS.ProcessEnv
): SyncContextCompressor | null {
  const gate = authorizeCompressor(
    readTools(workspaceDir),
    readToolConfig(workspaceDir),
    readSafetyPolicy(workspaceDir),
    env
  );
  if (!gate.allowed) return null;
  const compressor = createHeadroomSyncCompressor();
  return compressor.available ? compressor : null;
}

/**
 * Run ONE read-only review of an exact PR revision against an already-resolved
 * review input. Lifecycle: initial manifest + byte-exact input artifact →
 * governed skill (before any model call) → isolated worktree + byte-exact diff →
 * optional PR-body compression re-wrapped in a fresh untrusted fence →
 * credential-scrubbed, trusted-policy read-only lens/verify analysis →
 * schema-validated `analysis.json` → re-query for supersede/cancel → canonical
 * Markdown + text/markdown output. The worktree is always cleaned and the
 * manifest always finalized in `finally` — on success, supersede, cancel, or
 * failure. NO GitHub write capability exists in this slice.
 */
export async function runPullRequestReview(opts: {
  workspaceDir: string;
  packageDir: string;
  revision: PullRequestRevision;
  reviewInput: ResolvedReviewInput;
  config: PullRequestReviewConfig;
  agentId: AgentRuntimeId;
  fallbackAgentId?: AgentRuntimeId;
  autoSwitchOnLimit: boolean;
  modelRouting: boolean;
  tierLadder: TierLadder;
  tokenMode: TokenMode;
  contextCompressor: CompressorMode;
  maxRetries: number;
  cooldownMs: number;
  budgetUsd?: number;
  verbose: boolean;
  signal?: AbortSignal;
  deps?: Partial<PullRequestReviewDeps>;
}): Promise<PullRequestReviewRunResult> {
  const {
    workspaceDir,
    packageDir,
    revision,
    reviewInput,
    config,
    maxRetries,
    cooldownMs,
    tokenMode,
    modelRouting,
    tierLadder,
    verbose,
    signal,
  } = opts;

  const deps: PullRequestReviewDeps = {
    github: opts.deps?.github ?? {
      getPullRequest: () => {
        throw new Error("no GitHub client supplied to runPullRequestReview");
      },
    },
    analyze: opts.deps?.analyze ?? analyzeReview,
    createWorktree: opts.deps?.createWorktree ?? createPullRequestWorktree,
    writeReviewInput: opts.deps?.writeReviewInput ?? writeReviewInputArtifact,
    readReviewInput: opts.deps?.readReviewInput ?? readReviewInputArtifact,
    env: opts.deps?.env ?? process.env,
    now: opts.deps?.now ?? (() => new Date()),
    stdout: opts.deps?.stdout ?? ((t) => process.stdout.write(t)),
  };

  const repository = config.repository;
  const pullRequest = revision.number;
  const inputFingerprint = reviewInput.fingerprint;
  const headSha = revision.headSha;
  const requestedOutput = config.output;

  // --- Stateful dedup (Slice 2): a terminal composite identity short-circuits.
  //     `succeeded` is done; a permanent (or not-yet-eligible back-off) failure
  //     is likewise not re-run. A prior `running`/`publish-failed` run with a
  //     persisted analysis is RESUMED from `analysis.json` (no re-payment).
  const priorState = readReviewState(
    workspaceDir,
    repository,
    pullRequest,
    headSha,
    inputFingerprint
  );
  if (priorState && !isStateRunnable(priorState, deps.now())) {
    return {
      status: priorState.status as PullRequestReviewRunStatus,
      runId: priorState.runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: 0,
      reviewArtifact: `.otto/runs/${priorState.runId}/review.md`,
      ...(priorState.outputs.comment
        ? { commentId: priorState.outputs.comment.commentId }
        : {}),
      ...(priorState.retryable !== undefined
        ? { retryable: priorState.retryable }
        : {}),
      ...(priorState.nextRetryAt
        ? { nextRetryAt: priorState.nextRetryAt }
        : {}),
      ...(priorState.error ? { error: priorState.error } : {}),
    };
  }

  let resumedAnalysis: PullRequestReviewAnalysisArtifact | null = null;
  let runId: string;
  if (
    priorState &&
    (priorState.status === "running" ||
      priorState.status === "publish-failed") &&
    priorState.analysisArtifact
  ) {
    const resumed = readReviewAnalysisArtifact({
      workspaceDir,
      runId: priorState.runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
    });
    if (resumed) {
      resumedAnalysis = resumed;
      runId = priorState.runId;
    } else {
      // A tampered/missing analysis artifact is never trusted for resume — a
      // fresh analysis is run under a new run id.
      runId = allocateRunId(deps.now());
    }
  } else {
    runId = allocateRunId(deps.now());
  }
  const priorOutputs: PullRequestReviewOutputState = priorState?.outputs ?? {};
  const priorAttempts = priorState?.attempts ?? 0;

  const startedAt = deps.now().toISOString();
  const runDir = runReportDir(workspaceDir, runId);
  const expectedInputPath = `.otto/runs/${runId}/review-input.md`;

  let activeAgentId: AgentRuntimeId = opts.agentId;
  let worktree: ReturnType<typeof createPullRequestWorktree> | undefined;

  // Running evidence accumulated across every recorded stage (both attempts of a
  // fallback switch). `addTokenUsage` keeps the manifest totals exact.
  let manifestCost = 0;
  let manifestUsage: TokenUsage = emptyTokenUsage();
  const stageRecords: StageRecord[] = [];
  const runToolsUsed: ToolUsage[] = [];
  let seq = 0;
  const persistStage = (
    stageName: string,
    sr: StageResult,
    startedAtIso: string,
    reviewSeverity?: ReviewSeverityCounts
  ): void => {
    manifestCost += sr.costUsd;
    manifestUsage = addTokenUsage(manifestUsage, sr.usage);
    const record: StageRecord = {
      iteration: 1,
      stage: stageName,
      runtimeId: sr.runtimeId,
      costUsd: sr.costUsd,
      usage: sr.usage,
      isError: sr.isError,
      apiErrorStatus: sr.apiErrorStatus,
      ...(sr.logPath ? { logPath: sr.logPath } : {}),
      ...(sr.safetyEvents?.length ? { safetyEvents: sr.safetyEvents } : {}),
      ...(sr.skillsUsed?.length ? { skillsUsed: sr.skillsUsed } : {}),
      ...(sr.toolsUsed?.length ? { toolsUsed: sr.toolsUsed } : {}),
      ...(reviewSeverity ? { reviewSeverity } : {}),
      startedAt: startedAtIso,
      finishedAt: deps.now().toISOString(),
    };
    stageRecords.push(record);
    writeStageRecord(workspaceDir, runId, ++seq, record);
  };

  // Composite P32 evidence, refined at each terminal state.
  const buildEvidence = (
    over: Partial<PullRequestReviewEvidence> = {}
  ): PullRequestReviewEvidence => ({
    repository,
    pullRequest,
    url: revision.url,
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    label: config.label,
    reviewInput: {
      kind: reviewInput.kind,
      source: reviewInput.source,
      fingerprint: inputFingerprint,
      artifactPath: expectedInputPath,
    },
    confirmed: 0,
    rejected: 0,
    outputMode: config.output,
    githubReview: false,
    ...over,
  });

  const finalizeManifest = (
    exitReason: string,
    evidence: PullRequestReviewEvidence,
    artifacts: RunArtifact[]
  ): void => {
    const manifest: RunManifest = {
      runId,
      bin: "otto-review",
      mode: "github-pr-review",
      inputs: `${repository}#${pullRequest}`,
      runtime: { id: activeAgentId, displayName: activeAgentId },
      iterations: 1,
      completedIterations: 1,
      costUsd: manifestCost,
      tokenUsage: manifestUsage,
      exitReason,
      artifacts,
      ...(runToolsUsed.length ? { toolsUsed: runToolsUsed } : {}),
      pullRequestReview: evidence,
      startedAt,
      finishedAt: deps.now().toISOString(),
    };
    writeManifest(workspaceDir, manifest);
  };

  const artifactList = (over: RunArtifact[] = []): RunArtifact[] => [
    { kind: "review-input", path: expectedInputPath },
    ...over,
  ];

  const fail = (
    error: string,
    nextAction: string
  ): PullRequestReviewRunResult => {
    // Harness-authored failure report naming the exact identity + next action.
    const report =
      `# Otto review — analysis failed\n\n` +
      `- Repository: ${repository}\n` +
      `- Pull request: #${pullRequest}\n` +
      `- Head: ${revision.headSha}\n` +
      `- Review input: ${reviewInput.kind} (${inputFingerprint})\n\n` +
      `The review could not complete: ${error}\n\n` +
      `Next action: ${nextAction}\n`;
    writeRunReport(workspaceDir, runId, report);
    finalizeManifest("analysis-failed", buildEvidence(), artifactList());
    return {
      status: "analysis-failed",
      runId,
      repository,
      pullRequest,
      headSha: revision.headSha,
      inputFingerprint,
      costUsd: manifestCost,
      error,
    };
  };

  const analysisArtifactRel = `.otto/runs/${runId}/analysis.json`;

  /** Persist the durable per-composite-identity review state (best-effort). */
  const persistState = (
    over: Partial<PullRequestReviewState> &
      Pick<PullRequestReviewState, "status" | "outputs" | "attempts">
  ): void => {
    try {
      writeReviewState(workspaceDir, {
        repository,
        pullRequest,
        headSha,
        inputFingerprint,
        runId,
        updatedAt: deps.now().toISOString(),
        ...over,
      });
    } catch {
      // A state-write hiccup must not crash the run; idempotency degrades to the
      // remote marker reconciliation, which is still single-comment safe.
    }
  };

  /** The 4 comment methods, present only when a comment output was requested. */
  const commentClient = (): Pick<
    GitHubPrClient,
    "viewer" | "listIssueComments" | "createIssueComment" | "updateIssueComment"
  > | null => {
    const g = deps.github;
    if (
      g.viewer &&
      g.listIssueComments &&
      g.createIssueComment &&
      g.updateIssueComment
    ) {
      return {
        viewer: g.viewer.bind(g),
        listIssueComments: g.listIssueComments.bind(g),
        createIssueComment: g.createIssueComment.bind(g),
        updateIssueComment: g.updateIssueComment.bind(g),
      };
    }
    return null;
  };

  /**
   * Turn a persisted analysis into published output(s). Re-queries the PR
   * IMMEDIATELY before any remote write (reconcilePublication): a moved head or
   * an ineligible state marks the run superseded/cancelled and emits NO remote
   * output. On a publishable PR the summary comment is upserted idempotently by
   * marker — a restart with lost local state finds and reuses the existing
   * comment instead of duplicating it. Each output writes an INDEPENDENT receipt
   * and is never repeated once succeeded; a permanent GitHub error is a visible
   * `publish-failed`, a transient one carries `retryable`/`nextRetryAt`.
   */
  const finishPublication = (
    art: PullRequestReviewAnalysisArtifact,
    startingOutputs: PullRequestReviewOutputState
  ): PullRequestReviewRunResult => {
    const outcome = art.outcome;
    const published = art.confirmed;
    const diffArtifactRel = art.diffArtifact;
    const attempts = priorAttempts + 1;

    // Re-query the PR immediately before any remote write.
    const current = deps.github.getPullRequest(repository, pullRequest);
    const rec = reconcilePublication({
      expected: revision,
      current,
      label: config.label,
    });
    let status: PullRequestReviewRunStatus = "succeeded";
    let supersededBy: string | undefined;
    let staleReason: string | undefined;
    if (!rec.publishable) {
      status = rec.status;
      staleReason = `${rec.status}: ${rec.reason}`;
      if (rec.status === "superseded") supersededBy = current.headSha;
    }

    const canonical: CanonicalReview = {
      repository,
      pullRequest,
      url: revision.url,
      title: revision.title,
      baseSha: revision.baseSha,
      headSha,
      reviewInput: art.reviewInput,
      runId,
      outcome,
      confirmed: published,
      rejectedCount: art.rejected.length,
      suppressedCount: art.severity.suppressed,
      skill: art.skill,
      diffArtifact: diffArtifactRel,
      analysisArtifact: analysisArtifactRel,
      ...(staleReason ? { staleReason } : {}),
    };
    const canonicalMarkdown = renderCanonicalReview(canonical);
    // The local review copy is always retained (run bundle + optional
    // --output-file). A stale document is labelled stale, not marked successful.
    const written = writeCanonicalReview({
      workspaceDir,
      runId,
      markdown: canonicalMarkdown,
      outputFile:
        requestedOutput === "markdown" ? config.outputFile : undefined,
    });
    writeRunReport(workspaceDir, runId, canonicalMarkdown);

    const outputs: PullRequestReviewOutputState = { ...startingOutputs };
    let commentId: number | undefined = outputs.comment?.commentId;
    const finalArtifacts = artifactList([
      { kind: "diff", path: diffArtifactRel },
      { kind: "analysis", path: analysisArtifactRel },
      { kind: "review", path: written.artifactPath },
    ]);

    if (status === "succeeded") {
      if (requestedOutput === "text") {
        if (!outputs.text) outputs.text = { status: "succeeded" };
        deps.stdout(renderReviewText(canonical));
      } else if (requestedOutput === "markdown") {
        if (!outputs.markdown)
          outputs.markdown = {
            status: "succeeded",
            path: written.copiedPath ?? written.artifactPath,
          };
        deps.stdout(canonicalMarkdown);
      } else {
        // comment: a HARNESS-OWNED remote write, only after a passing reconcile.
        if (!outputs.comment) {
          const github = commentClient();
          try {
            if (!github) {
              throw new GitHubPrError(
                "comment output requires a GitHub client with viewer/list/create/update capability",
                "permission",
                false
              );
            }
            const receipt = upsertSummaryComment({
              github,
              repository,
              pullRequest,
              headSha,
              inputFingerprint,
              body: canonicalMarkdown,
            });
            outputs.comment = {
              status: "succeeded",
              commentId: receipt.commentId,
            };
            commentId = receipt.commentId;
          } catch (err) {
            const gerr =
              err instanceof GitHubPrError
                ? err
                : new GitHubPrError(
                    `summary comment publication failed: ${(err as Error).message}`,
                    "unknown",
                    false
                  );
            const retryable = gerr.retryable;
            const nextRetryAt = retryable
              ? nextPublicationRetryAt(attempts, deps.now())
              : undefined;
            persistState({
              status: "publish-failed",
              analysisArtifact: analysisArtifactRel,
              outputs,
              attempts,
              retryable,
              ...(nextRetryAt ? { nextRetryAt } : {}),
              error: gerr.message,
            });
            finalizeManifest(
              "publish-failed",
              buildEvidence({
                outcome,
                confirmed: published.length,
                rejected: art.rejected.length,
              }),
              finalArtifacts
            );
            deps.stdout(renderReviewText(canonical));
            return {
              status: "publish-failed",
              runId,
              repository,
              pullRequest,
              headSha,
              inputFingerprint,
              costUsd: manifestCost,
              outcome,
              reviewArtifact: written.artifactPath,
              retryable,
              ...(nextRetryAt ? { nextRetryAt } : {}),
              error: gerr.message,
            };
          }
        }
        deps.stdout(renderReviewText(canonical));
      }
    } else {
      // Superseded/cancelled: emit NO remote output; surface the stale copy.
      if (requestedOutput === "markdown") deps.stdout(canonicalMarkdown);
      else deps.stdout(renderReviewText(canonical));
    }

    persistState({
      status: status === "succeeded" ? "succeeded" : status,
      analysisArtifact: analysisArtifactRel,
      outputs,
      attempts,
    });
    finalizeManifest(
      status === "succeeded" ? outcome : status,
      buildEvidence({
        outcome,
        confirmed: published.length,
        rejected: art.rejected.length,
        ...(supersededBy ? { supersededBy } : {}),
      }),
      finalArtifacts
    );
    return {
      status,
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: manifestCost,
      outcome,
      reviewArtifact: written.artifactPath,
      ...(commentId !== undefined ? { commentId } : {}),
    };
  };

  /**
   * Comment-mode remote-proof recovery. If the viewer already owns a summary
   * comment carrying THIS composite identity's current head + input markers,
   * the review is already published: reconstruct a succeeded state from the
   * remote body WITHOUT paying for a fresh model analysis. Any adapter hiccup
   * falls through to the normal analysis path.
   */
  const tryRemoteRecovery = (): PullRequestReviewRunResult | null => {
    if (requestedOutput !== "comment") return null;
    const github = commentClient();
    if (!github) return null;
    let owned;
    try {
      const viewer = github.viewer();
      const marker = summaryMarker(repository, pullRequest);
      const h = headMarker(headSha);
      const i = inputMarker(inputFingerprint);
      owned = github
        .listIssueComments(repository, pullRequest)
        .find(
          (c) =>
            c.author === viewer.login &&
            c.body.includes(marker) &&
            c.body.includes(h) &&
            c.body.includes(i)
        );
    } catch {
      return null;
    }
    if (!owned) return null;

    // Persist the already-resolved exact input + the remote body as the
    // recovered run's local artifacts, then reconstruct succeeded state.
    try {
      deps.writeReviewInput({ workspaceDir, runId, input: reviewInput });
    } catch {
      /* best-effort: the remote comment is authoritative proof either way */
    }
    const written = writeCanonicalReview({
      workspaceDir,
      runId,
      markdown: owned.body,
    });
    writeRunReport(workspaceDir, runId, owned.body);
    const outputs: PullRequestReviewOutputState = {
      comment: { status: "succeeded", commentId: owned.id },
    };
    persistState({
      status: "succeeded",
      outputs,
      attempts: priorAttempts + 1,
    });
    finalizeManifest(
      "succeeded",
      buildEvidence(),
      artifactList([{ kind: "review", path: written.artifactPath }])
    );
    return {
      status: "succeeded",
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: 0,
      reviewArtifact: written.artifactPath,
      commentId: owned.id,
    };
  };

  // --- Acquire the composite claim BEFORE writing run/input artifacts or a
  //     worktree. A busy claim returns `skipped` with no analysis. Every
  //     acquired path heartbeats (unref'd interval) and releases in `finally`.
  const claimResult = claimRevision({
    workspaceDir,
    repository,
    pullRequest,
    headSha,
    inputFingerprint,
    runId,
    now: deps.now(),
  });
  if (!claimResult.acquired) {
    return {
      status: "skipped",
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: 0,
    };
  }
  const claim: PullRequestReviewClaim = claimResult.claim;
  const heartbeat = setInterval(() => {
    try {
      heartbeatClaim({ workspaceDir, claim, now: new Date() });
    } catch {
      /* best-effort */
    }
  }, REVIEW_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    // Resume a crashed/failed run from persisted analysis — never re-analyze.
    if (resumedAnalysis) {
      return finishPublication(resumedAnalysis, priorOutputs);
    }
    // Comment-mode: reuse an already-published remote comment (lost local state).
    const recovered = tryRemoteRecovery();
    if (recovered) return recovered;

    return await runFreshReview();
  } finally {
    clearInterval(heartbeat);
    releaseClaim({ workspaceDir, claim });
    if (worktree) worktree.cleanup();
  }

  // -------------------------------------------------------------------------
  // Fresh analysis + publication (no resumable state, no remote proof).
  // -------------------------------------------------------------------------
  async function runFreshReview(): Promise<PullRequestReviewRunResult> {
    // 1. Initial manifest (zero cost/tokens, composite evidence, expected input
    //    artifact path) + the byte-exact, round-trip-validated input artifact.
    writeManifest(workspaceDir, {
      runId,
      bin: "otto-review",
      mode: "github-pr-review",
      inputs: `${repository}#${pullRequest}`,
      runtime: { id: activeAgentId, displayName: activeAgentId },
      iterations: 1,
      costUsd: 0,
      tokenUsage: emptyTokenUsage(),
      artifacts: artifactList(),
      pullRequestReview: buildEvidence(),
      startedAt,
    });

    let snapshot: ReviewInputSnapshot;
    try {
      snapshot = deps.writeReviewInput({
        workspaceDir,
        runId,
        input: reviewInput,
      });
      const roundTrip = deps.readReviewInput({
        workspaceDir,
        runId,
        expectedFingerprint: inputFingerprint,
      });
      if (roundTrip == null || roundTrip.content !== reviewInput.content) {
        return fail(
          "review-input artifact failed round-trip validation",
          "re-run the review; the run directory could not persist the exact review input"
        );
      }
      snapshot = roundTrip;
    } catch (err) {
      return fail(
        `review-input artifact write failed: ${(err as Error).message}`,
        "check that the run directory is writable, then re-run the review"
      );
    }

    // 2. Resolve the governed skill BEFORE any model call.
    let skill: ReviewSkillSelection;
    try {
      skill = resolveReviewSkill({
        workspaceDir,
        requested: config.reviewSkill,
        changedPaths: revision.changedFiles,
        now: deps.now(),
      });
    } catch (err) {
      if (err instanceof ReviewSkillError) {
        return fail(
          `review skill selection failed: ${err.message}`,
          `choose a valid --review-skill (or omit it to use the built-in) for ${repository}#${pullRequest}`
        );
      }
      throw err;
    }

    // 3. Isolated worktree at the exact head + byte-exact diff artifact.
    //    Assigns the OUTER `worktree` so the claim `finally` always cleans it.
    let wt: ReturnType<typeof createPullRequestWorktree>;
    try {
      wt = deps.createWorktree({
        workspaceDir,
        runId,
        revision,
        reviewInput: snapshot,
      });
      worktree = wt;
    } catch (err) {
      return fail(
        `worktree creation failed: ${(err as Error).message}`,
        `verify the git remote can fetch ${repository}#${pullRequest}, then re-run the review`
      );
    }

    try {
      const diffArtifactRel = `.otto/runs/${runId}/pr.diff`;
      writeFileSync(join(runDir, "pr.diff"), wt.diffText);
      // The worktree's review-input copy MUST be byte-identical to the run artifact.
      const runInputBytes = readFileSync(
        join(runDir, "review-input.md"),
        "utf8"
      );
      if (wt.reviewInputText !== runInputBytes) {
        return fail(
          "worktree review-input copy is not byte-identical to the run artifact",
          "re-run the review; the isolated worktree did not preserve the exact review input"
        );
      }

      // 4. Optional PR-body compression, re-wrapped in a fresh untrusted fence.
      //    Only the raw PR body is ever offered to the compressor — never the
      //    review-input artifact.
      let bodyForContext = revision.body;
      if (opts.contextCompressor === "headroom") {
        const compressor = buildReviewCompressor(workspaceDir, deps.env);
        if (compressor) {
          const store = runRetrievalStore(workspaceDir, runId);
          const out = compressContentSync(
            compressor,
            { key: "pr-body", category: "issue-body", text: revision.body },
            store
          );
          bodyForContext = out.text;
          if (!out.degraded) {
            runToolsUsed.push(
              compressionToolUsage(out, "issue-body", "pr-review")
            );
          }
        }
      }
      const reviewContext = buildReviewContext({
        ...revision,
        body: bodyForContext,
      });

      // 5. Read the TRUSTED operator policy before entering the PR worktree, and
      //    scrub credentials for the read-only child.
      const safetyPolicy = readSafetyPolicy(workspaceDir);
      const emptyGithubConfigDir = join(wt.dir, ".otto-tmp", "gh-empty");
      mkdirSync(emptyGithubConfigDir, { recursive: true });
      const childEnv = buildReviewChildEnv(deps.env, emptyGithubConfigDir);

      const stageVars: Record<string, string> = {
        REPO_INSTRUCTIONS_PATH: wt.instructionsPath,
        BASE_SHA: revision.baseSha,
        HEAD_SHA: revision.headSha,
        DIFF_PATH: wt.diffPath,
        REVIEW_INPUT_PATH: wt.reviewInputPath,
        REVIEW_CONTEXT: reviewContext,
      };
      const inputSafetyEvents: SafetyEvent[] = [
        {
          category: "taint",
          kind: "pull-request",
          subject: `${repository}#${pullRequest}`,
          message: "pull-request context is untrusted review evidence",
          blocked: false,
        },
        {
          category: "taint",
          kind: "review-input",
          subject: inputFingerprint,
          message: "review input is untrusted acceptance-criteria data",
          blocked: false,
        },
      ];
      const skillUsages: SkillUsage[] = [skill.usage];

      let budgetExhausted = false;
      let spentUsd = 0;
      const onStage = (
        sr: StageResult
      ): { stop: boolean; cooldownFactor: number } => {
        spentUsd += sr.costUsd;
        const stop = opts.budgetUsd != null && spentUsd >= opts.budgetUsd;
        if (stop) budgetExhausted = true;
        return { stop, cooldownFactor: 1 };
      };

      const runAnalyzeOnce = (): Promise<ReviewAnalysisResult> =>
        deps.analyze({
          workspaceDir: wt.dir,
          packageDir,
          iteration: 1,
          maxRetries,
          cooldownMs,
          tokenMode,
          signal,
          agentId: activeAgentId,
          lenses: [...REVIEW_LENSES],
          lensStage: STAGES.prReviewLens,
          verifyStage: STAGES.prReviewVerify,
          stageVars,
          verdictSource: "result",
          mutationPolicy: "fail",
          strictFindings: true,
          childEnv,
          safetyPolicy,
          injectedContext: skill.injection,
          skillUsages,
          inputSafetyEvents,
          sink: verbose ? new VerboseSink() : new ConsoleUi(),
          modelRouting,
          tierLadder,
          onStage,
          recordStage: persistStage,
        });

      // Analysis with a single fallback switch on a rate limit. A switch discards
      // the (aborted) attempt entirely and re-runs fresh — never reusing partial
      // verdicts — with both attempts' completed stages recorded.
      let analysis: ReviewAnalysisResult;
      let switched = false;
      for (;;) {
        try {
          analysis = await runAnalyzeOnce();
          break;
        } catch (err) {
          if (err instanceof ReviewAnalysisContractError) {
            // Contract broken (stage error / strict malformed row / mutation under
            // read-only). Record any completed stages not yet persisted, then fail.
            for (
              let i = stageRecords.length;
              i < err.result.stageResults.length;
              i++
            ) {
              persistStage(
                `pr-review-stage-${i + 1}`,
                err.result.stageResults[i],
                startedAt
              );
            }
            return fail(
              `review analysis contract broken: ${err.result.contractErrors.join("; ") || "unknown"}`,
              `inspect .otto/runs/${runId}/ evidence, then re-run the review for ${repository}#${pullRequest}`
            );
          }
          if (
            (err as Error)?.name === "RateLimitError" &&
            opts.autoSwitchOnLimit &&
            opts.fallbackAgentId &&
            !switched &&
            activeAgentId !== opts.fallbackAgentId
          ) {
            switched = true;
            const from = activeAgentId;
            activeAgentId = opts.fallbackAgentId;
            deps.stdout(
              `↪ auto-switch on rate limit: ${from} → ${activeAgentId}\n`
            );
            continue;
          }
          return fail(
            `review analysis failed: ${(err as Error).message}`,
            `re-run the review for ${repository}#${pullRequest}`
          );
        }
      }

      // Budget exhaustion before verification is a failure, never "approved".
      if (budgetExhausted) {
        return fail(
          "review budget exhausted before verification completed",
          `raise --budget or narrow the review, then re-run for ${repository}#${pullRequest}`
        );
      }

      // 6. Structured, schema-validated analysis artifact + `running` state with
      //    the analysisArtifact reference — persisted BEFORE any output so a crash
      //    between here and publication resumes from `analysis.json` (no re-pay).
      const outcome = outcomeForFindings(analysis.confirmed);
      const published: PublishedReviewFinding[] = analysis.confirmed.map(
        (f) => ({
          ...f,
          inlineEligible: false,
        })
      );
      const analysisArtifact: PullRequestReviewAnalysisArtifact = {
        schemaVersion: 1,
        repository,
        pullRequest,
        url: revision.url,
        title: revision.title,
        baseSha: revision.baseSha,
        headSha: revision.headSha,
        reviewInput: {
          kind: reviewInput.kind,
          source: reviewInput.source,
          fingerprint: inputFingerprint,
          artifactPath: snapshot.artifactPath,
        },
        runId,
        analyzedAt: deps.now().toISOString(),
        outcome,
        confirmed: published,
        rejected: analysis.rejected,
        severity: analysis.severity,
        skill,
        diffArtifact: diffArtifactRel,
      };
      atomicWriteJson(join(runDir, "analysis.json"), analysisArtifact);
      persistState({
        status: "running",
        analysisArtifact: analysisArtifactRel,
        outputs: {},
        attempts: priorAttempts + 1,
      });

      // 7. Publish (re-query → reconcile → output) from the persisted analysis.
      return finishPublication(analysisArtifact, {});
    } catch (err) {
      return fail(
        `review failed: ${(err as Error).message}`,
        `re-run the review for ${repository}#${pullRequest}`
      );
    }
  }
}
