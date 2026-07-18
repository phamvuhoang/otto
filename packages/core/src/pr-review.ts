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
import type { GitHubPrClient } from "./github-pr.js";
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
  renderCanonicalReview,
  renderReviewText,
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
  | "superseded"
  | "cancelled";

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
  github: Pick<GitHubPrClient, "getPullRequest">;
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
  const runId = allocateRunId(deps.now());
  const startedAt = deps.now().toISOString();
  const runDir = runReportDir(workspaceDir, runId);
  const inputFingerprint = reviewInput.fingerprint;
  const expectedInputPath = `.otto/runs/${runId}/review-input.md`;

  let activeAgentId: AgentRuntimeId = opts.agentId;

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
  let worktree: ReturnType<typeof createPullRequestWorktree>;
  try {
    worktree = deps.createWorktree({
      workspaceDir,
      runId,
      revision,
      reviewInput: snapshot,
    });
  } catch (err) {
    return fail(
      `worktree creation failed: ${(err as Error).message}`,
      `verify the git remote can fetch ${repository}#${pullRequest}, then re-run the review`
    );
  }

  try {
    const diffArtifactRel = `.otto/runs/${runId}/pr.diff`;
    writeFileSync(join(runDir, "pr.diff"), worktree.diffText);
    // The worktree's review-input copy MUST be byte-identical to the run artifact.
    const runInputBytes = readFileSync(join(runDir, "review-input.md"), "utf8");
    if (worktree.reviewInputText !== runInputBytes) {
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
    const emptyGithubConfigDir = join(worktree.dir, ".otto-tmp", "gh-empty");
    mkdirSync(emptyGithubConfigDir, { recursive: true });
    const childEnv = buildReviewChildEnv(deps.env, emptyGithubConfigDir);

    const stageVars: Record<string, string> = {
      REPO_INSTRUCTIONS_PATH: worktree.instructionsPath,
      BASE_SHA: revision.baseSha,
      HEAD_SHA: revision.headSha,
      DIFF_PATH: worktree.diffPath,
      REVIEW_INPUT_PATH: worktree.reviewInputPath,
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
        workspaceDir: worktree.dir,
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

    // 6. Structured, schema-validated analysis artifact BEFORE any output.
    const outcome = outcomeForFindings(analysis.confirmed);
    const published: PublishedReviewFinding[] = analysis.confirmed.map((f) => ({
      ...f,
      inlineEligible: false,
    }));
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

    // 7. Re-query the PR: the snapshotted input stays authoritative, but a moved
    //    head supersedes and an ineligible state cancels this attempt.
    const current = deps.github.getPullRequest(repository, pullRequest);
    let status: PullRequestReviewRunStatus = "succeeded";
    let supersededBy: string | undefined;
    let staleReason: string | undefined;
    if (current.headSha !== revision.headSha) {
      status = "superseded";
      supersededBy = current.headSha;
      staleReason = `superseded: the PR head advanced to ${current.headSha} during review`;
    } else {
      const reason = ineligibleReason(current, config.label);
      if (reason === "closed") {
        status = "cancelled";
        staleReason = "cancelled: the pull request is no longer open";
      } else if (reason === "draft") {
        status = "cancelled";
        staleReason = "cancelled: the pull request was converted to draft";
      } else if (reason === "label-missing") {
        status = "cancelled";
        staleReason = `cancelled: the required label "${config.label}" was removed`;
      }
    }

    // 8. Canonical Markdown (with input marker/evidence + any stale reason), then
    //    the text or Markdown copy.
    const canonical: CanonicalReview = {
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
      outcome,
      confirmed: published,
      rejectedCount: analysis.rejected.length,
      suppressedCount: analysis.severity.suppressed,
      skill,
      diffArtifact: diffArtifactRel,
      analysisArtifact: `.otto/runs/${runId}/analysis.json`,
      ...(staleReason ? { staleReason } : {}),
    };
    const canonicalMarkdown = renderCanonicalReview(canonical);
    const written = writeCanonicalReview({
      workspaceDir,
      runId,
      markdown: canonicalMarkdown,
      outputFile: config.output === "markdown" ? config.outputFile : undefined,
    });
    writeRunReport(workspaceDir, runId, canonicalMarkdown);
    if (config.output === "markdown") {
      deps.stdout(canonicalMarkdown);
    } else {
      deps.stdout(renderReviewText(canonical));
    }

    const evidence = buildEvidence({
      outcome,
      confirmed: published.length,
      rejected: analysis.rejected.length,
      ...(supersededBy ? { supersededBy } : {}),
    });
    finalizeManifest(
      status === "succeeded" ? outcome : status,
      evidence,
      artifactList([
        { kind: "diff", path: diffArtifactRel },
        { kind: "analysis", path: `.otto/runs/${runId}/analysis.json` },
        { kind: "review", path: written.artifactPath },
      ])
    );

    return {
      status,
      runId,
      repository,
      pullRequest,
      headSha: revision.headSha,
      inputFingerprint,
      costUsd: manifestCost,
      outcome,
      reviewArtifact: written.artifactPath,
    };
  } catch (err) {
    return fail(
      `review failed: ${(err as Error).message}`,
      `re-run the review for ${repository}#${pullRequest}`
    );
  } finally {
    worktree.cleanup();
  }
}
