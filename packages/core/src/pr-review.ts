/**
 * P32 automated pull-request code review: the pure revision domain (identity,
 * eligibility, severity→outcome) plus the one-shot read-only review pipeline
 * ({@link runPullRequestReview}) that wires the resolved input, isolated worktree,
 * governed skill, read-only lens/verify analysis, structured artifact, and
 * canonical output together. Slice 1 renders text/markdown only — it holds NO
 * GitHub write capability (its `deps.github` is `getPullRequest`-only).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
import {
  GitHubPrError,
  type GitHubPrClient,
  type GitHubComment,
  type GitHubReview,
} from "./github-pr.js";
import {
  reconcilePublication,
  upsertSummaryComment,
  publishFormalReview,
  nextPublicationRetryAt,
  resolveOwnedUnique,
  ReviewWriteAbortedError,
  ReviewWriteSupersededError,
  type PublicationReconciliation,
} from "./pr-review-publish.js";
import { mapFindingsToDiff } from "./pr-review-diff.js";
import {
  readReviewState,
  writeReviewState,
  acquireReviewLease,
  isStateRunnable,
  type PullRequestReviewState,
  type PullRequestReviewOutputState,
  type ReviewLease,
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
  parseCanonicalFormalEnvelope,
  parseCanonicalSummaryEnvelope,
  renderCanonicalReview,
  renderReviewText,
  writeCanonicalReview,
  type CanonicalReview,
  type PublishedReviewFinding,
} from "./pr-review-output.js";
import type { PullRequestReviewConfig } from "./review-cli.js";
import {
  allocateRunId,
  readManifest,
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
  /** The published formal GitHub review id (--github-review only). */
  reviewId?: number;
  /** For an analysis/publication failure: whether a bounded retry may recover. */
  retryable?: boolean;
  /** For a retryable analysis/publication failure: next-eligible timestamp. */
  nextRetryAt?: string;
  /**
   * For a `skipped` result: WHY it was skipped. This is the EXPLICIT
   * discriminator between the two skip producers — never inferred from
   * `costUsd` (Codex stages always report `costUsd: 0`, so a cost heuristic
   * misclassifies an interrupted Codex run as busy).
   *   - `"busy"`               another process already owns the lease; NO
   *                            work happened.
   *   - `"interrupted"`        paid analysis completed and a resumable state
   *                            was persisted, but publication did not finish.
   *   - `"aborted-before-work"` the lease WAS acquired but the caller signal
   *                            was already aborted before any analysis ran —
   *                            NO analysis completed and NO resumable state
   *                            was persisted (distinct from `"interrupted"`,
   *                            which happens strictly after paid analysis).
   */
  skipReason?: "busy" | "interrupted" | "aborted-before-work";
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
  schemaVersion: 2;
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
  diffSha256: string;
};

const SHA_RE = /^[0-9a-fA-F]{40,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const REVIEW_INPUT_KINDS = new Set([
  "none",
  "github-issue",
  "local-file",
  "prompt",
]);
const OUTCOMES = new Set<PullRequestReviewOutcome>([
  "changes-requested",
  "comment",
  "approved",
]);
const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFindingLocation(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const match = value.match(/^([1-9]\d*)(?:-([1-9]\d*))?$/);
  if (!match) return false;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  return (
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
  );
}

function parseFinding(value: unknown, published: boolean): Finding | null {
  if (!isRecord(value)) return null;
  const required = published
    ? ["severity", "file", "claim", "why", "inlineEligible"]
    : ["severity", "file", "claim", "why"];
  const optional = published
    ? ["line", "suggestedFix", "lens", "side", "mappedLine"]
    : ["line", "suggestedFix", "lens"];
  if (!hasKeys(value, required, optional)) return null;
  if (
    typeof value.severity !== "string" ||
    !SEVERITIES.has(value.severity) ||
    !isNonEmptyString(value.file) ||
    !isFindingLocation(value.line) ||
    !isNonEmptyString(value.claim) ||
    !isNonEmptyString(value.why) ||
    !isOptionalNonEmptyString(value.suggestedFix) ||
    !isOptionalNonEmptyString(value.lens)
  ) {
    return null;
  }
  if (published) {
    if (typeof value.inlineEligible !== "boolean") return null;
    if (value.inlineEligible) {
      if (
        (value.side !== "LEFT" && value.side !== "RIGHT") ||
        !Number.isSafeInteger(value.mappedLine) ||
        (value.mappedLine as number) <= 0
      ) {
        return null;
      }
    } else if (value.side !== undefined || value.mappedLine !== undefined) {
      return null;
    }
  }
  return value as unknown as Finding;
}

function parseSkill(value: unknown): ReviewSkillSelection | null {
  if (!isRecord(value)) return null;
  if (
    !hasKeys(value, [
      "name",
      "version",
      "source",
      "checksum",
      "injection",
      "usage",
    ]) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.version) ||
    !isNonEmptyString(value.source) ||
    !FINGERPRINT_RE.test(String(value.checksum)) ||
    typeof value.injection !== "string" ||
    !isRecord(value.usage)
  ) {
    return null;
  }
  const usage = value.usage;
  if (
    !hasKeys(
      usage,
      ["name", "version", "source", "stage", "checksum"],
      ["ref", "reasons"]
    ) ||
    usage.name !== value.name ||
    usage.version !== value.version ||
    usage.source !== value.source ||
    usage.stage !== "pr-review" ||
    usage.checksum !== value.checksum ||
    !isOptionalNonEmptyString(usage.ref) ||
    (usage.reasons !== undefined &&
      (!Array.isArray(usage.reasons) || !usage.reasons.every(isNonEmptyString)))
  ) {
    return null;
  }
  return value as unknown as ReviewSkillSelection;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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
  baseSha: string;
  headSha: string;
  inputFingerprint: string;
  reviewInput: ResolvedReviewInput;
}): PullRequestReviewAnalysisArtifact | null {
  try {
    if (
      opts.runId === "." ||
      opts.runId === ".." ||
      !RUN_ID_RE.test(opts.runId) ||
      !SHA_RE.test(opts.baseSha) ||
      !SHA_RE.test(opts.headSha) ||
      !FINGERPRINT_RE.test(opts.inputFingerprint)
    ) {
      return null;
    }
    const runDir = runReportDir(opts.workspaceDir, opts.runId);
    const path = join(runDir, "analysis.json");
    if (!lstatSync(path).isFile()) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) return null;
    if (
      !hasKeys(raw, [
        "schemaVersion",
        "repository",
        "pullRequest",
        "url",
        "title",
        "baseSha",
        "headSha",
        "reviewInput",
        "runId",
        "analyzedAt",
        "outcome",
        "confirmed",
        "rejected",
        "severity",
        "skill",
        "diffArtifact",
        "diffSha256",
      ]) ||
      raw.schemaVersion !== 2 ||
      raw.repository !== opts.repository ||
      raw.pullRequest !== opts.pullRequest ||
      !isNonEmptyString(raw.url) ||
      typeof raw.title !== "string" ||
      raw.baseSha !== opts.baseSha ||
      raw.headSha !== opts.headSha ||
      raw.runId !== opts.runId ||
      typeof raw.analyzedAt !== "string" ||
      new Date(raw.analyzedAt).toISOString() !== raw.analyzedAt ||
      typeof raw.outcome !== "string" ||
      !OUTCOMES.has(raw.outcome as PullRequestReviewOutcome) ||
      !Array.isArray(raw.confirmed) ||
      !Array.isArray(raw.rejected) ||
      !isRecord(raw.reviewInput) ||
      !isRecord(raw.severity)
    ) {
      return null;
    }

    const expectedInputPath = `.otto/runs/${opts.runId}/review-input.md`;
    if (
      !hasKeys(raw.reviewInput, [
        "kind",
        "source",
        "fingerprint",
        "artifactPath",
      ]) ||
      typeof raw.reviewInput.kind !== "string" ||
      !REVIEW_INPUT_KINDS.has(raw.reviewInput.kind) ||
      raw.reviewInput.kind !== opts.reviewInput.kind ||
      raw.reviewInput.source !== opts.reviewInput.source ||
      raw.reviewInput.fingerprint !== opts.inputFingerprint ||
      raw.reviewInput.fingerprint !== opts.reviewInput.fingerprint ||
      raw.reviewInput.artifactPath !== expectedInputPath
    ) {
      return null;
    }

    const confirmed = raw.confirmed.map((finding) =>
      parseFinding(finding, true)
    );
    const rejected = raw.rejected.map((finding) =>
      parseFinding(finding, false)
    );
    if (
      confirmed.some((finding) => finding === null) ||
      rejected.some((finding) => finding === null)
    )
      return null;

    if (
      !hasKeys(raw.severity, [
        "blocker",
        "major",
        "minor",
        "nit",
        "suppressed",
      ]) ||
      !Object.values(raw.severity).every(isCount)
    ) {
      return null;
    }
    const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
    for (const finding of confirmed as Finding[]) counts[finding.severity]++;
    if (
      raw.severity.blocker !== counts.blocker ||
      raw.severity.major !== counts.major ||
      raw.severity.minor !== counts.minor ||
      raw.severity.nit !== counts.nit + (raw.severity.suppressed as number)
    ) {
      return null;
    }
    if (parseSkill(raw.skill) === null) return null;

    const expectedDiffPath = `.otto/runs/${opts.runId}/pr.diff`;
    if (
      raw.diffArtifact !== expectedDiffPath ||
      typeof raw.diffSha256 !== "string" ||
      !FINGERPRINT_RE.test(raw.diffSha256)
    ) {
      return null;
    }
    const diffPath = join(opts.workspaceDir, expectedDiffPath);
    if (!lstatSync(diffPath).isFile()) return null;
    const realRunDir = realpathSync(runDir);
    const realDiffPath = realpathSync(diffPath);
    if (dirname(realDiffPath) !== realRunDir) return null;
    if (fileSha256(diffPath) !== raw.diffSha256) return null;

    if (raw.outcome !== outcomeForFindings(confirmed as Finding[])) {
      return null;
    }
    return raw as unknown as PullRequestReviewAnalysisArtifact;
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
        | "listReviews"
        | "createReview"
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
  //     `succeeded` is done; watch mode also blocks permanent/not-yet-eligible
  //     failures, while an explicit one-shot may retry a permanent analysis
  //     failure after an operator fix. A prior `running`/`publish-failed` run
  //     with persisted analysis is RESUMED from `analysis.json` (no re-payment).
  const priorState = readReviewState(
    workspaceDir,
    repository,
    pullRequest,
    headSha,
    inputFingerprint
  );
  const oneShotPermanentAnalysisRetry =
    !config.watch &&
    priorState?.status === "analysis-failed" &&
    priorState.retryable !== true;
  if (
    priorState &&
    !isStateRunnable(priorState, deps.now()) &&
    !oneShotPermanentAnalysisRetry
  ) {
    const reviewArtifact = `.otto/runs/${priorState.runId}/review.md`;
    return {
      status: priorState.status as PullRequestReviewRunStatus,
      runId: priorState.runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: 0,
      ...(existsSync(join(workspaceDir, reviewArtifact))
        ? { reviewArtifact }
        : {}),
      ...(priorState.outputs.comment
        ? { commentId: priorState.outputs.comment.commentId }
        : {}),
      ...(priorState.outputs.githubReview
        ? { reviewId: priorState.outputs.githubReview.reviewId }
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
      baseSha: revision.baseSha,
      headSha,
      inputFingerprint,
      reviewInput,
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
  // These track only analysis that was validated and ACTUALLY resumed in this
  // invocation (or freshly persisted below). An old state's mere pointer is not
  // authority to suppress a new failure record.
  let durableAnalysisForInvocation = resumedAnalysis;
  let durableAnalysisOutputs: PullRequestReviewOutputState | null =
    resumedAnalysis ? { ...priorOutputs } : null;

  const startedAt = deps.now().toISOString();
  const runDir = runReportDir(workspaceDir, runId);
  const expectedInputPath = `.otto/runs/${runId}/review-input.md`;
  let inputArtifactDurable = false;

  let activeAgentId: AgentRuntimeId = opts.agentId;
  let worktree: ReturnType<typeof createPullRequestWorktree> | undefined;

  // Running evidence accumulated across every recorded stage (both attempts of a
  // fallback switch). `addTokenUsage` keeps the manifest totals exact.
  // NOTE: `manifestCost`/`manifestUsage` track ONLY THIS invocation's spend —
  // this is what the returned result reports so the daemon's per-invocation
  // watch-budget counts only what this run actually paid.
  let manifestCost = 0;
  let manifestUsage: TokenUsage = emptyTokenUsage();

  // Cumulative evidence CARRIED FORWARD from a resumed run's prior manifest. On
  // a resume we reuse the original runId and re-init this invocation's totals to
  // zero; without carrying the prior paid analysis's manifest, finalization
  // would erase the first (paying) invocation's provenance and evidence. Null on
  // a fresh run, so behavior is unchanged there.
  const priorManifest = resumedAnalysis
    ? readManifest(workspaceDir, runId)
    : null;
  const priorManifestCost = priorManifest?.costUsd ?? 0;
  const priorManifestUsage = priorManifest?.tokenUsage ?? emptyTokenUsage();
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
    over: Partial<PullRequestReviewEvidence> = {},
    includeInput = inputArtifactDurable
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
      artifactPath: includeInput ? expectedInputPath : null,
    },
    confirmed: 0,
    rejected: 0,
    outputMode: config.output,
    githubReview: false,
    ...over,
  });

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

  const finalizeManifest = (
    exitReason: string,
    evidence: PullRequestReviewEvidence,
    artifacts: RunArtifact[]
  ): void => {
    const toolsUsed = mergeTools(priorManifest?.toolsUsed, runToolsUsed);
    const priorArtifacts =
      evidence.reviewInput.artifactPath === null
        ? priorManifest?.artifacts.filter(
            (artifact) => artifact.kind !== "review-input"
          )
        : priorManifest?.artifacts;
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
      // Cumulative across resume: prior paid analysis + this invocation. Never
      // less than the prior manifest, so a resumed publication cannot erase the
      // first invocation's recorded cost/tokens.
      costUsd: priorManifestCost + manifestCost,
      tokenUsage: addTokenUsage(priorManifestUsage, manifestUsage),
      exitReason,
      artifacts: mergeArtifacts(priorArtifacts, artifacts),
      ...(toolsUsed.length ? { toolsUsed } : { toolsUsed: undefined }),
      pullRequestReview: evidence,
      startedAt: priorManifest?.startedAt ?? startedAt,
      finishedAt: deps.now().toISOString(),
    };
    writeManifest(workspaceDir, manifest);
  };

  const artifactList = (
    over: RunArtifact[] = [],
    includeInput = inputArtifactDurable
  ): RunArtifact[] => [
    ...(includeInput
      ? [{ kind: "review-input", path: expectedInputPath } as RunArtifact]
      : []),
    ...over,
  ];

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
      retryable,
      ...(nextRetryAt ? { nextRetryAt } : {}),
      error,
    };
  };

  const analysisArtifactRel = `.otto/runs/${runId}/analysis.json`;

  // Run-scoped abort: fed ONLY by the caller's shutdown `signal`. Passed to the
  // analysis pass and checked before any remote write so an aborted run stops.
  const runAbort = new AbortController();

  /**
   * BUSY before any work (the lease was not acquired): NO run happened, so
   * nothing is finalized and the cost is genuinely zero. Distinct from the
   * aborted-after-analysis path, which finalizes with the real accumulated cost.
   */
  const busySkippedResult = (): PullRequestReviewRunResult => ({
    status: "skipped",
    skipReason: "busy",
    runId,
    repository,
    pullRequest,
    headSha,
    inputFingerprint,
    costUsd: 0,
  });

  /**
   * Materialize the review-input artifact + a run report on a terminal path that
   * would otherwise finalize a manifest referencing `review-input.md` (via
   * `artifactList`) without ever having written it, and with no report on disk.
   * Mirrors the recovery SUCCESS path + `finishPublication`: no dangling manifest
   * reference, evidence retrievable via otto-explain.
   *
   * DURABLE-OR-OMITTED: records and returns whether the input was durably written
   * (a round-trip-verified fsync+rename, exactly as the recovery SUCCESS path
   * requires). Both evidence builders use that shared authority, so a run-dir
   * write hiccup never leaves the finalized manifest pointing at a file that is
   * not on disk. The write failure must NOT mask the terminal outcome — it is
   * still finalized.
   */
  const materializeReferencedInput = (report: string): boolean => {
    inputArtifactDurable = false;
    try {
      deps.writeReviewInput({ workspaceDir, runId, input: reviewInput });
      // Round-trip verify (as runFreshReview + recovery do) so a manifest that
      // references review-input.md is never a dangling pointer.
      const roundTrip = deps.readReviewInput({
        workspaceDir,
        runId,
        expectedFingerprint: inputFingerprint,
      });
      inputArtifactDurable =
        roundTrip != null && roundTrip.content === reviewInput.content;
    } catch {
      // Best-effort: the run dir may be unwritable. The caller OMITS the
      // review-input artifact from the finalized manifest; the terminal outcome
      // is still recorded below.
    }
    try {
      writeRunReport(workspaceDir, runId, report);
    } catch {
      // Best-effort.
    }
    return inputArtifactDurable;
  };

  const validateInputArtifact = (): boolean => {
    try {
      const roundTrip = deps.readReviewInput({
        workspaceDir,
        runId,
        expectedFingerprint: inputFingerprint,
      });
      inputArtifactDurable =
        roundTrip != null && roundTrip.content === reviewInput.content;
    } catch {
      inputArtifactDurable = false;
    }
    return inputArtifactDurable;
  };

  /**
   * ACQUIRED then aborted before any work: the lease WAS taken (this is NOT lock
   * contention), but the caller shut down before analysis. Distinct from
   * `busySkippedResult` (lease not acquired → "another process" is misleading
   * here) — surface the interrupted semantics, finalize retrievable evidence, and
   * let the outer `finally` release the acquired lease. No spend (cost 0).
   */
  const interruptedBeforeWorkResult = (): PullRequestReviewRunResult => {
    materializeReferencedInput(
      `# Otto review — interrupted before analysis\n\n` +
        `- Repository: ${repository}\n` +
        `- Pull request: #${pullRequest}\n` +
        `- Head: ${revision.headSha}\n` +
        `- Review input: ${reviewInput.kind} (${inputFingerprint})\n\n` +
        `The run acquired its lease but the caller shut down before any ` +
        `analysis ran; no remote output was published. Re-run to complete it.\n`
    );
    finalizeManifest("aborted", buildEvidence(), artifactList());
    return {
      status: "skipped",
      skipReason: "aborted-before-work",
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: 0,
    };
  };

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
      if (over.analysisArtifact !== undefined) {
        durableAnalysisOutputs = { ...over.outputs };
      }
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

  /** The formal-review methods, present only when --github-review is on. */
  const reviewClient = (): Pick<
    GitHubPrClient,
    "viewer" | "listReviews" | "createReview"
  > | null => {
    const g = deps.github;
    if (g.viewer && g.listReviews && g.createReview) {
      return {
        viewer: g.viewer.bind(g),
        listReviews: g.listReviews.bind(g),
        createReview: g.createReview.bind(g),
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

    /**
     * Aborted/lost AFTER acquisition and PAID analysis (caller shutdown at the
     * publication boundary, or a per-write ownership loss): publish nothing
     * further, but PRESERVE the spend. Finalize the manifest with the real
     * accumulated cost and persist a RESUMABLE `running` state that retains the
     * analysis artifact so a later run reuses the paid analysis. This is a
     * DISTINCT terminal path from the busy skip (which does nothing at cost 0).
     */
    const abortedResumable = (
      outputs: PullRequestReviewOutputState,
      commentId?: number,
      reviewId?: number
    ): PullRequestReviewRunResult => {
      persistState({
        status: "running",
        analysisArtifact: analysisArtifactRel,
        outputs,
        attempts,
      });
      finalizeManifest(
        "aborted",
        buildEvidence({
          outcome,
          confirmed: published.length,
          rejected: art.rejected.length,
          githubReview: outputs.githubReview !== undefined,
          ...(commentId !== undefined ? { commentId } : {}),
          ...(reviewId !== undefined ? { reviewId } : {}),
        }),
        artifactList([
          { kind: "diff", path: diffArtifactRel },
          { kind: "analysis", path: analysisArtifactRel },
        ])
      );
      return {
        status: "skipped",
        // Paid analysis ran and a resumable state was persisted, but publication
        // did not finish. EXPLICIT reason — do NOT infer from costUsd, which is
        // 0 for Codex stages even here.
        skipReason: "interrupted",
        runId,
        repository,
        pullRequest,
        headSha,
        inputFingerprint,
        // This invocation's accumulated spend, for the daemon's budget accounting.
        costUsd: manifestCost,
        outcome,
        ...(commentId !== undefined ? { commentId } : {}),
        ...(reviewId !== undefined ? { reviewId } : {}),
      };
    };

    /**
     * A publication-phase metadata READ (getPullRequest → reconcile) failed
     * AFTER the paid analysis succeeded. This is NOT an analysis failure and must
     * never (a) be misclassified as `analysis-failed` by the outer analysis
     * catch, nor (b) escape unfinalized on a resumed run. Route it through
     * publish-failed, PRESERVING the completed analysis and any already-persisted
     * receipts. Retryable-vs-permanent is classified from the error exactly like
     * a remote-write `GitHubPrError` (Defect #3).
     */
    const publicationReadFailure = (
      err: unknown,
      outputs: PullRequestReviewOutputState,
      reviewArtifactPath?: string
    ): PullRequestReviewRunResult => {
      const gerr =
        err instanceof GitHubPrError
          ? err
          : new GitHubPrError(
              `publication metadata read failed: ${(err as Error).message}`,
              "unknown",
              false
            );
      const retryable = gerr.retryable;
      const nextRetryAt = retryable
        ? nextPublicationRetryAt(attempts, deps.now())
        : undefined;
      const commentId = outputs.comment?.commentId;
      const reviewId = outputs.githubReview?.reviewId;
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
          githubReview: outputs.githubReview !== undefined,
          ...(commentId !== undefined ? { commentId } : {}),
          ...(reviewId !== undefined ? { reviewId } : {}),
        }),
        artifactList([
          { kind: "diff", path: diffArtifactRel },
          { kind: "analysis", path: analysisArtifactRel },
          ...(reviewArtifactPath
            ? [{ kind: "review", path: reviewArtifactPath } as RunArtifact]
            : []),
        ])
      );
      return {
        status: "publish-failed",
        runId,
        repository,
        pullRequest,
        headSha,
        inputFingerprint,
        costUsd: manifestCost,
        outcome,
        ...(reviewArtifactPath ? { reviewArtifact: reviewArtifactPath } : {}),
        ...(commentId !== undefined ? { commentId } : {}),
        ...(reviewId !== undefined ? { reviewId } : {}),
        retryable,
        ...(nextRetryAt ? { nextRetryAt } : {}),
        error: gerr.message,
      };
    };

    // Caller shutdown detected at the publication boundary: preserve the spend
    // AND any receipt already proven on a prior (resumed) invocation, so the
    // finalized manifest/result reflect the retained comment/review receipts
    // rather than dropping them (Defect #2).
    if (runAbort.signal.aborted)
      return abortedResumable(
        startingOutputs,
        startingOutputs.comment?.commentId,
        startingOutputs.githubReview?.reviewId
      );

    // Re-query the PR immediately before any remote write. A metadata-read
    // failure here is a PUBLICATION failure (analysis already succeeded), not an
    // analysis failure — finalize it as publish-failed rather than letting it be
    // caught by the outer analysis catch or escape unfinalized on a resume.
    let current: PullRequestRevision;
    try {
      current = deps.github.getPullRequest(repository, pullRequest);
    } catch (err) {
      return publicationReadFailure(err, startingOutputs);
    }
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

    /**
     * Apply a write-boundary (or formal-review pre-write) reconcile miss: the PR
     * moved on / lost eligibility AFTER the cheap outer reconcile but BEFORE this
     * remote write, so the write is withheld and the run becomes
     * superseded/cancelled (NOT the aborted/resumable path). Re-render the LOCAL
     * canonical copy as stale; any already-succeeded receipt from an earlier write
     * in this run is preserved by the caller (it only touches status/stale
     * fields). Mirrors the outer supersession at the publication boundary.
     */
    const applyWriteSupersession = (
      rec: Extract<PublicationReconciliation, { publishable: false }>
    ): void => {
      status = rec.status;
      staleReason = `${rec.status}: ${rec.reason}`;
      supersededBy =
        rec.status === "superseded" ? rec.current.headSha : undefined;
      const staleMarkdown = renderCanonicalReview({
        ...canonical,
        staleReason,
      });
      writeCanonicalReview({
        workspaceDir,
        runId,
        markdown: staleMarkdown,
        outputFile:
          requestedOutput === "markdown" ? config.outputFile : undefined,
      });
      writeRunReport(workspaceDir, runId, staleMarkdown);
    };

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
            // Per-write ownership fence: revalidate ownership + abort immediately
            // before this remote write. If shutdown fired or we no longer own the
            // claim, publish nothing further and take the aborted/resumable path.
            if (runAbort.signal.aborted || !lease.ownsClaim()) {
              return abortedResumable(outputs);
            }
            const receipt = upsertSummaryComment({
              github,
              repository,
              pullRequest,
              headSha,
              inputFingerprint,
              body: canonicalMarkdown,
              // Re-check at the write boundary: a caller shutdown that fires
              // DURING the helper's viewer/list reads still withholds the write,
              // AND a FRESH re-query catches a head that advanced (or eligibility
              // lost) during those reads so no stale analysis is published.
              ensureAuthorized: () => {
                if (runAbort.signal.aborted || !lease.ownsClaim()) {
                  throw new ReviewWriteAbortedError();
                }
                const fresh = deps.github.getPullRequest(
                  repository,
                  pullRequest
                );
                const freshRec = reconcilePublication({
                  expected: revision,
                  current: fresh,
                  label: config.label,
                });
                if (!freshRec.publishable) {
                  throw new ReviewWriteSupersededError(freshRec);
                }
              },
            });
            outputs.comment = {
              status: "succeeded",
              commentId: receipt.commentId,
            };
            commentId = receipt.commentId;
            // Persist the proven receipt IMMEDIATELY (status stays `running`
            // until the full publication finalizes) so a later publication-phase
            // read failure — e.g. the pre-formal-review getPullRequest below —
            // can never lose this remote write locally (Defect #3).
            persistState({
              status: "running",
              analysisArtifact: analysisArtifactRel,
              outputs,
              attempts,
            });
          } catch (err) {
            // A write-boundary abort is NOT a publish failure: withhold the write
            // and take the aborted/resumable terminal path, preserving any prior
            // receipt.
            if (err instanceof ReviewWriteAbortedError) {
              return abortedResumable(outputs);
            }
            // A FRESH re-query at the write boundary found the PR moved on /
            // ineligible: withhold this comment and drive the run to
            // superseded/cancelled (no comment receipt is recorded for it).
            if (err instanceof ReviewWriteSupersededError) {
              applyWriteSupersession(err.reconcile);
            } else {
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
        }
        // On a write-boundary supersession the comment was withheld and status is
        // no longer "succeeded": surface the STALE copy instead of the fresh one.
        deps.stdout(
          renderReviewText(
            status === "succeeded" ? canonical : { ...canonical, staleReason }
          )
        );
      }
    } else {
      // Superseded/cancelled: emit NO remote output; surface the stale copy.
      if (requestedOutput === "markdown") deps.stdout(canonicalMarkdown);
      else deps.stdout(renderReviewText(canonical));
    }

    // --github-review is an ADDITIONAL, INDEPENDENT receipt: a harness-owned
    // formal GitHub review submitted once per composite identity, only after the
    // same passing reconcile, and never re-submitted once succeeded. Its marker
    // reconciliation (publishFormalReview) keeps a restart from ever posting a
    // duplicate. A prior succeeded summary comment receipt is left intact when a
    // formal-review write fails.
    let reviewId: number | undefined = outputs.githubReview?.reviewId;
    if (
      status === "succeeded" &&
      config.githubReview &&
      !outputs.githubReview
    ) {
      // Re-query the PR AGAIN immediately before this INDEPENDENT remote write.
      // The summary comment above was gated by its own fresh reconcile and, on a
      // publishable PR, has already been written; the formal review is a SEPARATE
      // remote write and needs its OWN fresh gate. A head that advanced (or an
      // eligibility loss) AFTER the comment but BEFORE the review must withhold
      // the review as superseded/cancelled while preserving the comment receipt.
      // A metadata-read FAILURE here (after the comment already published) is a
      // publication failure, not an analysis failure: finalize publish-failed
      // while preserving the persisted comment receipt (Defect #3).
      let preReview: PullRequestRevision;
      try {
        preReview = deps.github.getPullRequest(repository, pullRequest);
      } catch (err) {
        return publicationReadFailure(err, outputs, written.artifactPath);
      }
      const rec2 = reconcilePublication({
        expected: revision,
        current: preReview,
        label: config.label,
      });
      if (!rec2.publishable) {
        // Cheap pre-write reconcile miss: withhold the formal review and re-render
        // the LOCAL canonical copy as stale. The already-published summary comment,
        // valid under its own gate, is left untouched remotely and its receipt is
        // preserved (applyWriteSupersession only touches status/stale fields).
        applyWriteSupersession(rec2);
      } else {
        const github = reviewClient();
        try {
          if (!github) {
            throw new GitHubPrError(
              "github review output requires a GitHub client with viewer/listReviews/createReview capability",
              "permission",
              false
            );
          }
          // Per-write ownership fence immediately before this INDEPENDENT remote
          // write: an abort or an ownership loss between the comment and the
          // formal review withholds the review while preserving the comment.
          if (runAbort.signal.aborted || !lease.ownsClaim()) {
            return abortedResumable(outputs, commentId);
          }
          const receipt = publishFormalReview({
            github,
            review: canonical,
            // Re-check at the write boundary: a caller shutdown during the
            // helper's viewer/list reads withholds the review write, AND a FRESH
            // re-query catches a head that advanced (or eligibility lost) DURING
            // listReviews so no stale review is posted.
            ensureAuthorized: () => {
              if (runAbort.signal.aborted || !lease.ownsClaim()) {
                throw new ReviewWriteAbortedError();
              }
              const fresh = deps.github.getPullRequest(repository, pullRequest);
              const freshRec = reconcilePublication({
                expected: revision,
                current: fresh,
                label: config.label,
              });
              if (!freshRec.publishable) {
                throw new ReviewWriteSupersededError(freshRec);
              }
            },
          });
          outputs.githubReview = {
            status: "succeeded",
            reviewId: receipt.reviewId,
          };
          reviewId = receipt.reviewId;
          // Persist the proven formal-review receipt IMMEDIATELY (same discipline
          // as the comment receipt) so a later throw cannot lose it (Defect #3).
          persistState({
            status: "running",
            analysisArtifact: analysisArtifactRel,
            outputs,
            attempts,
          });
        } catch (err) {
          // A write-boundary abort withholds the review while preserving the
          // already-succeeded comment receipt (resumable terminal path).
          if (err instanceof ReviewWriteAbortedError) {
            return abortedResumable(outputs, commentId);
          }
          // A FRESH re-query during listReviews found the PR moved on / ineligible
          // AFTER the comment already published: withhold the review and drive the
          // run to superseded/cancelled, preserving the comment receipt (commentId
          // remains set and flows into the final state/evidence/result).
          if (err instanceof ReviewWriteSupersededError) {
            applyWriteSupersession(err.reconcile);
          } else {
            const gerr =
              err instanceof GitHubPrError
                ? err
                : new GitHubPrError(
                    `formal review publication failed: ${(err as Error).message}`,
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
                githubReview: false,
                ...(commentId !== undefined ? { commentId } : {}),
              }),
              finalArtifacts
            );
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
              ...(commentId !== undefined ? { commentId } : {}),
              retryable,
              ...(nextRetryAt ? { nextRetryAt } : {}),
              error: gerr.message,
            };
          }
        }
      }
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
        githubReview: outputs.githubReview !== undefined,
        ...(commentId !== undefined ? { commentId } : {}),
        ...(reviewId !== undefined ? { reviewId } : {}),
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
      ...(reviewId !== undefined ? { reviewId } : {}),
    };
  };

  /**
   * An unexpected LOCAL exception after analysis became durable is a
   * publication/resume failure, never a fresh analysis failure. Preserve the
   * analysis pointer and latest durably written receipts, use the same bounded
   * retry clock as ordinary publication failures, and finalize the full analysis
   * evidence without replacing an already-written canonical report.
   */
  const unexpectedPublicationFailure = (
    art: PullRequestReviewAnalysisArtifact,
    err: unknown
  ): PullRequestReviewRunResult => {
    const outputs = durableAnalysisOutputs ?? {};
    const attempts = priorAttempts + 1;
    const retryable = true;
    const nextRetryAt = nextPublicationRetryAt(attempts, deps.now());
    const error = `publication failed after analysis: ${(err as Error).message}`;
    const reviewArtifact = `.otto/runs/${runId}/review.md`;
    const hasReviewArtifact = existsSync(join(workspaceDir, reviewArtifact));
    const reportPath = join(runDir, "report.md");
    const commentId = outputs.comment?.commentId;
    const reviewId = outputs.githubReview?.reviewId;

    persistState({
      status: "publish-failed",
      analysisArtifact: analysisArtifactRel,
      outputs,
      attempts,
      retryable,
      nextRetryAt,
      error,
    });
    if (!existsSync(reportPath)) {
      writeRunReport(
        workspaceDir,
        runId,
        `# Otto review — publication failed\n\n` +
          `The analysis completed, but local publication finalization failed: ${error}\n\n` +
          `Re-run after ${nextRetryAt}; the durable analysis will be reused.\n`
      );
    }
    finalizeManifest(
      "publish-failed",
      buildEvidence({
        outcome: art.outcome,
        confirmed: art.confirmed.length,
        rejected: art.rejected.length,
        githubReview: outputs.githubReview !== undefined,
        ...(commentId !== undefined ? { commentId } : {}),
        ...(reviewId !== undefined ? { reviewId } : {}),
      }),
      artifactList([
        { kind: "diff", path: art.diffArtifact },
        { kind: "analysis", path: analysisArtifactRel },
        ...(hasReviewArtifact
          ? [{ kind: "review", path: reviewArtifact } as RunArtifact]
          : []),
      ])
    );
    return {
      status: "publish-failed",
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: manifestCost,
      outcome: art.outcome,
      ...(hasReviewArtifact ? { reviewArtifact } : {}),
      ...(commentId !== undefined ? { commentId } : {}),
      ...(reviewId !== undefined ? { reviewId } : {}),
      retryable,
      nextRetryAt,
      error,
    };
  };

  /**
   * Comment-mode remote-proof recovery. If the viewer already owns a summary
   * comment carrying THIS composite identity's current head + input markers,
   * the review is already published: reconstruct a succeeded state from the
   * remote body WITHOUT paying for a fresh model analysis. Any adapter hiccup
   * falls through to the normal analysis path.
   */
  /**
   * A permanent reconciliation error surfaced DURING recovery (a `>1` owned
   * marker): treat it exactly like a permanent publish error — persist a
   * non-retryable `publish-failed` and return it, NEVER a silent success.
   */
  const recoveryPermanentFailure = (
    err: unknown,
    // A receipt already PROVEN before the permanent `>1` conflict was found (a
    // valid single summary comment resolved before the duplicate FORMAL reviews
    // were discovered). It MUST be carried into the result/state/evidence — not
    // zeroed to a misleading "no output delivered".
    proven: { commentId?: number; reviewId?: number } = {}
  ): PullRequestReviewRunResult => {
    const gerr =
      err instanceof GitHubPrError
        ? err
        : new GitHubPrError(
            `recovery reconciliation failed: ${(err as Error).message}`,
            "unknown",
            false
          );
    const attempts = priorAttempts + 1;
    // Write the review-input artifact + a run report BEFORE finalizing (the
    // finalized manifest references review-input.md via artifactList): no
    // dangling reference, evidence retrievable — same discipline as the recovery
    // SUCCESS path and finishPublication.
    materializeReferencedInput(
      `# Otto review — recovery reconciliation failed\n\n` +
        `- Repository: ${repository}\n` +
        `- Pull request: #${pullRequest}\n` +
        `- Head: ${revision.headSha}\n` +
        `- Review input: ${reviewInput.kind} (${inputFingerprint})\n\n` +
        `Recovery could not reconcile a single owned output: ${gerr.message}\n`
    );
    const outputs: PullRequestReviewOutputState = {
      ...(proven.commentId !== undefined
        ? {
            comment: {
              status: "succeeded" as const,
              commentId: proven.commentId,
            },
          }
        : {}),
      ...(proven.reviewId !== undefined
        ? {
            githubReview: {
              status: "succeeded" as const,
              reviewId: proven.reviewId,
            },
          }
        : {}),
    };
    persistState({
      status: "publish-failed",
      outputs,
      attempts,
      retryable: gerr.retryable,
      error: gerr.message,
    });
    finalizeManifest(
      "publish-failed",
      buildEvidence({
        ...(proven.commentId !== undefined
          ? { commentId: proven.commentId }
          : {}),
        ...(proven.reviewId !== undefined ? { reviewId: proven.reviewId } : {}),
      }),
      artifactList()
    );
    return {
      status: "publish-failed",
      runId,
      repository,
      pullRequest,
      headSha,
      inputFingerprint,
      costUsd: manifestCost,
      ...(proven.commentId !== undefined
        ? { commentId: proven.commentId }
        : {}),
      ...(proven.reviewId !== undefined ? { reviewId: proven.reviewId } : {}),
      retryable: gerr.retryable,
      error: gerr.message,
    };
  };

  const tryRemoteRecovery = (): PullRequestReviewRunResult | null => {
    // An aborted run must never reuse-and-republish a remote comment.
    if (runAbort.signal.aborted) return null;
    if (requestedOutput !== "comment") return null;
    const github = commentClient();
    if (!github) return null;
    let viewerLogin: string;
    let comments: GitHubComment[];
    try {
      viewerLogin = github.viewer().login;
      comments = github.listIssueComments(repository, pullRequest);
    } catch {
      return null;
    }
    let owned: GitHubComment | null;
    try {
      // Resolve uniqueness EXACTLY as upsertSummaryComment does: by author + the
      // stable summaryMarker ONLY (never also head/input). A SECOND owned summary
      // comment — even a stale-head one — is therefore a permanent `>1`
      // reconciliation error here, identical to what publication would reject, not
      // a silently-ignored duplicate. (Also matching on the composite head+input
      // would find the one head match and declare success while a second owned
      // summary comment that publication rejects still existed on the PR.)
      owned = resolveOwnedUnique(
        comments,
        (c) => {
          const envelope = parseCanonicalSummaryEnvelope(c.body);
          return (
            c.author === viewerLogin &&
            envelope?.repository === repository &&
            envelope.pullRequest === pullRequest
          );
        },
        (count) =>
          `found ${count} canonical Otto summary comments on ` +
          `${repository}#${pullRequest}; refusing to guess which to update — ` +
          `remove the duplicates so a single owned comment remains`
      );
    } catch (err) {
      return recoveryPermanentFailure(err);
    }
    if (!owned) return null;
    const summaryEnvelope = parseCanonicalSummaryEnvelope(owned.body);
    if (!summaryEnvelope) return null;
    // The SINGLE owned comment proves THIS composite identity is published only
    // when it carries the current head AND input markers. A stale-head/older-input
    // owned comment does NOT prove it — fall through to the normal analysis path
    // (which UPDATES that same comment in place) rather than declaring success.
    if (
      summaryEnvelope.headSha !== headSha ||
      summaryEnvelope.inputFingerprint !== inputFingerprint
    )
      return null;

    // Recovery may declare full success ONLY when every configured remote output
    // is provably complete. With --github-review, a crash after the comment but
    // before the formal review would otherwise let a later run find the comment,
    // declare success, and PERMANENTLY skip the review. So when a formal review
    // was requested, also require an owned review carrying THIS composite marker
    // (same ownership predicate publishFormalReview uses: author === viewer).
    let recoveredReviewId: number | undefined;
    if (config.githubReview) {
      const reviews = reviewClient();
      if (!reviews) return null;
      let reviewViewer: string;
      let reviewList: GitHubReview[];
      try {
        reviewViewer = reviews.viewer().login;
        reviewList = reviews.listReviews(repository, pullRequest);
      } catch {
        return null;
      }
      let ownedReview: GitHubReview | null;
      try {
        ownedReview = resolveOwnedUnique(
          reviewList,
          (r) => {
            const envelope = parseCanonicalFormalEnvelope(r.body);
            return (
              r.author === reviewViewer &&
              envelope?.repository === repository &&
              envelope.pullRequest === pullRequest &&
              envelope.headSha === headSha &&
              envelope.inputFingerprint === inputFingerprint
            );
          },
          (count) =>
            `found ${count} canonical Otto formal reviews for this identity on ` +
            `${repository}#${pullRequest}; refusing to guess which represents ` +
            `this review — remove the duplicates so a single owned review remains`
        );
      } catch (err) {
        // The single owned summary comment was ALREADY proven above (its head +
        // input markers matched): carry that receipt into the permanent failure
        // rather than discarding it as "no output delivered".
        return recoveryPermanentFailure(err, { commentId: owned.id });
      }
      // Comment present but the owned formal review is absent: do NOT declare
      // success. Fall through so the normal analysis path completes the review.
      if (!ownedReview) return null;
      recoveredReviewId = ownedReview.id;
    }

    // Persist the already-resolved exact input as the recovered run's local
    // review-input artifact BEFORE the finalized manifest references it, and
    // round-trip verify it (matching runFreshReview's write+verify guarantee) so
    // the manifest never points at a missing/corrupt artifact. If the run dir
    // cannot durably persist the input, do NOT record a false success on a
    // dangling reference — fall through to the normal path (which fails loudly if
    // the dir is unwritable).
    try {
      deps.writeReviewInput({ workspaceDir, runId, input: reviewInput });
      const roundTrip = deps.readReviewInput({
        workspaceDir,
        runId,
        expectedFingerprint: inputFingerprint,
      });
      inputArtifactDurable =
        roundTrip != null && roundTrip.content === reviewInput.content;
      if (!inputArtifactDurable) {
        return null;
      }
    } catch {
      return null;
    }
    const written = writeCanonicalReview({
      workspaceDir,
      runId,
      markdown: owned.body,
    });
    // Emit the run report (consistent with finishPublication) so otto-explain and
    // evidence tooling work for a recovered run.
    writeRunReport(workspaceDir, runId, owned.body);
    const outputs: PullRequestReviewOutputState = {
      comment: { status: "succeeded", commentId: owned.id },
      ...(recoveredReviewId !== undefined
        ? {
            githubReview: {
              status: "succeeded" as const,
              reviewId: recoveredReviewId,
            },
          }
        : {}),
    };
    persistState({
      status: "succeeded",
      outputs,
      attempts: priorAttempts + 1,
    });
    finalizeManifest(
      "succeeded",
      buildEvidence({
        outcome: summaryEnvelope.outcome,
        confirmed: summaryEnvelope.confirmed,
        rejected: summaryEnvelope.rejected,
        githubReview: recoveredReviewId !== undefined,
        commentId: owned.id,
        ...(recoveredReviewId !== undefined
          ? { reviewId: recoveredReviewId }
          : {}),
      }),
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
      outcome: summaryEnvelope.outcome,
      reviewArtifact: written.artifactPath,
      commentId: owned.id,
      ...(recoveredReviewId !== undefined
        ? { reviewId: recoveredReviewId }
        : {}),
    };
  };

  // --- Acquire the OS-flock composite lease BEFORE writing run/input artifacts
  //     or a worktree. The lease takes an exclusive non-blocking `flock` on a
  //     per-identity lock file; a busy (LIVE) holder returns `skipped` with no
  //     analysis — the kernel serializes acquisition so two racers can never both
  //     acquire. A crashed holder's lock is auto-released by the kernel (no PID
  //     probe, no stale-claim takeover). The lease is released in `finally`, and
  //     its `ownsClaim()` fences every remote write.
  const leaseResult = acquireReviewLease({
    workspaceDir,
    repository,
    pullRequest,
    headSha,
    inputFingerprint,
    runId,
  });
  if (!leaseResult.acquired) {
    return busySkippedResult();
  }
  const lease: ReviewLease = leaseResult.lease;

  // Wire the caller's shutdown `signal` into the run-scoped abort: the analysis
  // is cancelled and every remote-write path bails (see the fences in
  // finishPublication and the abort guard below).
  // The forward listener MUST be detached in `finally` on EVERY exit (success,
  // abort, or throw): the caller's `signal` is a long-lived daemon signal reused
  // across every watch iteration, so a per-run listener that never fired
  // ({ once } only removes itself when abort actually fires) would otherwise
  // accumulate on it — unbounded memory growth + an eventual MaxListeners
  // warning. `removeEventListener` is idempotent, so if `{ once: true }` already
  // removed the listener (abort fired) the finally detach is a harmless no-op.
  let detachCallerAbort: (() => void) | undefined;
  if (signal?.aborted) runAbort.abort();
  else if (signal) {
    const onCallerAbort = (): void => {
      if (!runAbort.signal.aborted) runAbort.abort();
    };
    signal.addEventListener("abort", onCallerAbort, { once: true });
    detachCallerAbort = () =>
      signal.removeEventListener("abort", onCallerAbort);
  }

  try {
    // Resume a crashed/failed run from persisted analysis — never re-analyze.
    // This MUST precede the fresh pre-abort branch below: a resumed run reuses
    // the prior runId, so finalizing "aborted-before-work" here would OVERWRITE
    // the paid manifest's cost/tokens/outputs/receipts with zero-cost evidence
    // and hide the first (paying) invocation (Defect #2). finishPublication's own
    // pre-write abort check (abortedResumable) preserves the resumed spend +
    // receipts and keeps the run resumable; the lease still releases in `finally`.
    if (resumedAnalysis) {
      if (!validateInputArtifact()) {
        try {
          deps.writeReviewInput({ workspaceDir, runId, input: reviewInput });
        } catch {
          // Publication can still resume from valid analysis, but its finalized
          // evidence must explicitly omit an unavailable input artifact.
        }
        validateInputArtifact();
      }
      try {
        return finishPublication(resumedAnalysis, priorOutputs);
      } catch (err) {
        return unexpectedPublicationFailure(resumedAnalysis, err);
      }
    }
    // FRESH run: the lease WAS acquired but the caller shut down before any work —
    // a caller-abort, NOT lock contention. Surface the interrupted semantics
    // (never the "another process is already reviewing" busy result) and finalize
    // retrievable evidence; the acquired lease is released in `finally`.
    if (runAbort.signal.aborted) return interruptedBeforeWorkResult();
    // Comment-mode: reuse an already-published remote comment (lost local state).
    const recovered = tryRemoteRecovery();
    if (recovered) return recovered;

    return await runFreshReview();
  } finally {
    // Detach the caller-signal forward listener so it never accumulates on the
    // long-lived daemon signal across watch iterations (Defect #7).
    detachCallerAbort?.();
    lease.release();
    if (worktree) worktree.cleanup();
  }

  // -------------------------------------------------------------------------
  // Fresh analysis + publication (no resumable state, no remote proof).
  // -------------------------------------------------------------------------
  async function runFreshReview(): Promise<PullRequestReviewRunResult> {
    // 1. Initial manifest (zero cost/tokens, no input reference until the exact
    //    artifact has been durably written and round-trip validated).
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
      inputArtifactDurable =
        roundTrip != null && roundTrip.content === reviewInput.content;
      if (!inputArtifactDurable) {
        return fail(
          "review-input artifact failed round-trip validation",
          "re-run the review; the run directory could not persist the exact review input",
          false
        );
      }
      snapshot = roundTrip!;
    } catch (err) {
      return fail(
        `review-input artifact write failed: ${(err as Error).message}`,
        "check that the run directory is writable, then re-run the review",
        false
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
          `choose a valid --review-skill (or omit it to use the built-in) for ${repository}#${pullRequest}`,
          false
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
        `verify the git remote can fetch ${repository}#${pullRequest}, then re-run the review`,
        true
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
          "re-run the review; the isolated worktree did not preserve the exact review input",
          false
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
          // Run-scoped: aborts on caller signal OR a stolen-lock compromise.
          signal: runAbort.signal,
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
              `inspect .otto/runs/${runId}/ evidence, then re-run the review for ${repository}#${pullRequest}`,
              false
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
            `re-run the review for ${repository}#${pullRequest}`,
            true
          );
        }
      }

      // Budget exhaustion before verification is a failure, never "approved".
      if (budgetExhausted) {
        return fail(
          "review budget exhausted before verification completed",
          `raise --budget or narrow the review, then re-run for ${repository}#${pullRequest}`,
          true
        );
      }

      // 6. Structured, schema-validated analysis artifact + `running` state with
      //    the analysisArtifact reference — persisted BEFORE any output so a crash
      //    between here and publication resumes from `analysis.json` (no re-pay).
      const outcome = outcomeForFindings(analysis.confirmed);
      // Map + persist the exact diff placement of each confirmed finding when a
      // formal review was requested, so publication (now or on a later restart)
      // reads the mappings from analysis.json and never recomputes from a
      // different diff. Non-review runs keep every finding body-only.
      const published: PublishedReviewFinding[] = config.githubReview
        ? mapFindingsToDiff(analysis.confirmed, wt.diffText)
        : analysis.confirmed.map((f) => ({ ...f, inlineEligible: false }));
      const analysisArtifact: PullRequestReviewAnalysisArtifact = {
        schemaVersion: 2,
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
        diffSha256: createHash("sha256")
          .update(wt.diffText, "utf8")
          .digest("hex"),
      };
      atomicWriteJson(join(runDir, "analysis.json"), analysisArtifact);
      persistState({
        status: "running",
        analysisArtifact: analysisArtifactRel,
        outputs: {},
        attempts: priorAttempts + 1,
      });
      durableAnalysisForInvocation = analysisArtifact;

      // 7. Publish (re-query → reconcile → output) from the persisted analysis.
      return finishPublication(analysisArtifact, {});
    } catch (err) {
      if (durableAnalysisForInvocation) {
        return unexpectedPublicationFailure(durableAnalysisForInvocation, err);
      }
      return fail(
        `review failed: ${(err as Error).message}`,
        `re-run the review for ${repository}#${pullRequest}`,
        true
      );
    }
  }
}
