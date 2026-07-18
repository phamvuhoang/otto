import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { DEFAULT_AGENT, type AgentRuntimeId } from "./agent-runtime.js";
import { git } from "./git.js";
import { executeStage } from "./stage-exec.js";
import { tierForLens, type TierLadder } from "./model-tier.js";
import { sleep } from "./pacing.js";
import { classifyRisk, reviewDepthForLevel, selectLenses } from "./risk.js";
import type { RiskAssessment } from "./risk.js";
import {
  dedupeFindings,
  findingToWire,
  parseFindings,
  parseReviewVerdicts,
  severityCounts,
  suppressLowValue,
  type Finding,
} from "./review-severity.js";
import type { StageResult } from "./runner.js";
import type { Stage } from "./stages.js";
import type { EventSink } from "./console-ui.js";
import type { SafetyEvent, SkillUsage } from "./run-report.js";
import type { SafetyPolicy } from "./safety-policy.js";
import { bold, dim, green, red, SYM } from "./stream-render.js";
import { emptyTokenUsage, type TokenMode } from "./tokens.js";

/** Which lenses actually run this iteration. Router off → the full configured
 *  pool (today's behavior). Router on → risk-routed subset (Task 5). */
export function routedLenses(
  changedPaths: string[],
  available: string[],
  adaptiveRouter: boolean
): string[] {
  if (!adaptiveRouter) return [...available];
  const depth = reviewDepthForLevel(classifyRisk(changedPaths).level);
  const routed = selectLenses(depth, available);
  if (routed.length) return routed;
  // depth === "single" → no lens subset, but the panel always runs ≥1 lens.
  // Fall back to the medium subset (correctness/tests/task-fit — drops the
  // strong-tier structural/security lenses, matching the low-risk depth) before
  // the full pool, so a low-risk change still gets a proportionate review.
  const medium = selectLenses("lenses", available);
  return medium.length ? medium : [...available];
}

/** Parse every lens's findings file, tag with its lens, and dedupe across lenses
 *  so the verifier sees each issue once. `total` is the pre-dedupe count. */
export function mergeLensFindings(files: { lens: string; text: string }[]): {
  findings: Finding[];
  total: number;
} {
  const all: Finding[] = [];
  for (const { lens, text } of files)
    all.push(...parseFindings(text, lens).findings);
  return { findings: dedupeFindings(all), total: all.length };
}

/** Bounded-concurrency map over `items` (inline to avoid coupling to fanout.ts).
 *  Preserves input order in the result array regardless of completion order. */
async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** Max lens agents run concurrently (independent read-only reviews of one HEAD). */
const LENS_CONCURRENCY = 4;

const LENS_STAGE: Stage = {
  name: "review-lens",
  template: "review-lens.md",
  permissionMode: "bypassPermissions",
};
const VERIFY_STAGE = {
  name: "review-verify",
  template: "review-verify.md",
  permissionMode: "bypassPermissions",
};
const SYNTH_STAGE = {
  name: "review-synth",
  template: "review-synth.md",
  permissionMode: "bypassPermissions",
};

/** Phase start line: `● review · <label>`. */
function phaseLine(label: string): void {
  process.stderr.write(
    `${bold(SYM.bullet)} ${bold("review")} ${dim(`· ${label}`)}\n`
  );
}
/** Phase outcome line: `  ⎿ ✓ <note>` (ok) or `  ⎿ ✗ <note>` (anomaly). */
function outcomeLine(note: string, ok = true): void {
  const mark = ok ? green(SYM.check) : red(SYM.cross);
  process.stderr.write(`${dim(SYM.cont)} ${mark} ${dim(note)}\n`);
}

/** The verifier's verdicts.md, parsed. `exists` distinguishes "contract met" from
 *  "verifier never wrote the file" — the counts are display-only (the synth agent,
 *  not this regex, is the authority on what counts as CONFIRMED). */
type Verdicts = { exists: boolean; confirmed: number; rejected: number };
function readVerdicts(panelHostDir: string): Verdicts {
  try {
    const txt = readFileSync(join(panelHostDir, "verdicts.md"), "utf8");
    return {
      exists: true,
      confirmed: (txt.match(/^\s*CONFIRMED\b/gim) || []).length,
      rejected: (txt.match(/^\s*REJECTED\b/gim) || []).length,
    };
  } catch {
    return { exists: false, confirmed: 0, rejected: 0 };
  }
}

/** True if the worktree has uncommitted changes (tracked edits or new untracked
 *  files), excluding gitignored paths. Null git output (e.g. no repo) = not dirty. */
function worktreeDirty(workspaceDir: string): boolean {
  const s = git(["status", "--porcelain"], workspaceDir);
  return s != null && s !== "";
}

/** Per-sub-agent control returned by the loop: budget-stop + adaptive cooldown. */
export type PanelStageControl = { stop: boolean; cooldownFactor: number };

export type RunPanelOptions = {
  lenses: string[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  tokenMode?: TokenMode;
  signal?: AbortSignal;
  /** Changed paths this iteration; routes the lens subset when the adaptive
   *  router is on. Default `[]` (with router off) keeps the full pool. */
  changedPaths?: string[];
  /** Adaptive router on → risk-routed lens subset. Default false → full pool. */
  adaptiveRouter?: boolean;
  /** Model routing on → per-lens tier resolves through the ladder. Default false
   *  → runtime default model for every lens (today's behavior). */
  modelRouting?: boolean;
  /** tier → model ladder consulted when `modelRouting` resolves a lens tier. */
  tierLadder?: TierLadder;
  /** Change-risk assessment that modulates the routed per-lens tier. */
  riskAssessment?: RiskAssessment;
  /** Active runtime id; threaded into each sub-stage so panel logs are runtime-labelled. */
  agentId?: AgentRuntimeId;
  /** Resume/switch note injected into each panel sub-stage prompt. */
  resumeNote?: string;
  /** Cross-task interaction notes from a fan-out run (P25 Task 3's
   *  `FanoutResult.crossTaskSummary`); `undefined`/`""` when fan-out didn't run
   *  or found nothing noteworthy. Injected into the lens + verify prompts and,
   *  when it flags an out-of-scope touch, forces the `structural` lens in. */
  crossTaskSummary?: string;
  /**
   * Called after every panel sub-agent (each lens + synth) so the loop owns
   * budget + adaptive pacing for them too. Returns whether the budget is now
   * exhausted (stop the panel) and the current adaptive cooldown factor.
   */
  onStage?: (sr: StageResult) => PanelStageControl;
  /**
   * Called after every panel sub-agent (each lens + verify + synth) so the loop
   * can write one evidence record per substage. The lens substages are named by
   * their lens (free text from OTTO_REVIEW_LENSES); verify/synth use their stage
   * names. `startedAt` is the ISO timestamp captured before the substage ran.
   * `reviewSeverity` is passed only for the verify and synth substages.
   */
  recordStage?: (
    stageName: string,
    sr: StageResult,
    startedAt: string,
    reviewSeverity?: {
      blocker: number;
      major: number;
      minor: number;
      nit: number;
      suppressed: number;
    }
  ) => void;
};

/** Tracked-only worktree dirtiness ("" = clean). Untracked files are ignored. */
function trackedStatus(workspaceDir: string): string | null {
  return git(["status", "--porcelain", "--untracked-files=no"], workspaceDir);
}

/** True if HEAD moved or a tracked file changed since `baseHead`. */
function lensMutatedRepo(
  workspaceDir: string,
  baseHead: string | null
): boolean {
  if (baseHead == null) return false;
  if (git(["rev-parse", "HEAD"], workspaceDir) !== baseHead) return true;
  // Tracked-only: a lens scratch file (untracked) is harmless — synth diffs HEAD.
  return trackedStatus(workspaceDir) !== "";
}

/** Bounded block surfacing a fan-out run's cross-task interactions (shared
 *  files, out-of-scope touches, deferrals) to the review panel — analogous to
 *  `formatSharpeningGuidance`. `""` when there is no summary to show, so the
 *  prompt is byte-for-byte unchanged on a non-fan-out run. */
export function formatCrossTaskBlock(summary: string | undefined): string {
  if (!summary) return "";
  return `<cross-task-summary>\nThe implementation ran in parallel. Review these interactions:\n${summary}\n</cross-task-summary>`;
}

/** Per-severity tally plus the low-value-suppressed count (issue P32). */
export type ReviewSeverityCounts = {
  blocker: number;
  major: number;
  minor: number;
  nit: number;
  suppressed: number;
};

/**
 * Structured, read-only outcome of the review panel's analysis phase (issue P32):
 * the adversarially-CONFIRMED findings that survived low-value suppression
 * (`confirmed`), the REJECTED findings, the severity tally derived from ALL
 * confirmed findings BEFORE suppression (`severity`, with `suppressed` counting
 * the dropped low-value findings), the ordered `stageResults` for evidence, and
 * any `contractErrors` collected. NO synth/fix stage is involved — this is the
 * shape P32's analysis-only review consumes, and the substrate `runPanel` gates
 * its synth stage on.
 */
export type ReviewAnalysisResult = {
  confirmed: Finding[];
  rejected: Finding[];
  severity: ReviewSeverityCounts;
  stageResults: StageResult[];
  contractErrors: string[];
  /** File/substrate path only: the verifier's ORIGINAL `verdicts.md` text (its
   *  real CONFIRMED + REJECTED split), captured before cleanup and handed to the
   *  substrate synth so it fixes ONLY the CONFIRMED subset — never a reconstructed
   *  all-CONFIRMED file. Absent in the `verdictSource:"result"` (P32) path, which
   *  exposes the true split structurally via `confirmed`/`rejected`. */
  verifierVerdicts?: string;
};

/**
 * Options for {@link analyzeReview}. A superset of {@link RunPanelOptions} (minus
 * the callbacks it re-declares as optional) that adds the P32 review knobs:
 * pinned lens/verify stages, extra template vars, injected skill context, a
 * scrubbed child env, a trusted safety policy, a console sink, skill/taint
 * evidence to fold into every returned `StageResult`, strict-parsing toggles, the
 * verdict source (`file` keeps `runPanel`'s verdicts.md flow; `result` parses the
 * verifier's returned text), and the mutation policy (`restore` keeps the
 * reset-and-continue guard; `fail` turns a mutation into a contract error).
 */
export type ReviewAnalysisOptions = Omit<
  RunPanelOptions,
  "lenses" | "onStage" | "recordStage"
> & {
  lenses: string[];
  lensStage?: Stage;
  verifyStage?: Stage;
  stageVars?: Record<string, string>;
  injectedContext?: string;
  childEnv?: NodeJS.ProcessEnv;
  sink?: EventSink;
  skillUsages?: SkillUsage[];
  inputSafetyEvents?: SafetyEvent[];
  safetyPolicy?: SafetyPolicy;
  strictFindings?: boolean;
  verdictSource?: "file" | "result";
  mutationPolicy?: "restore" | "fail";
  onStage?: RunPanelOptions["onStage"];
  recordStage?: RunPanelOptions["recordStage"];
};

/** Thrown when review analysis breaks its contract (a stage error, a strict
 *  malformed finding/verdict, or a mutation under `mutationPolicy:"fail"`). It
 *  carries the partial {@link ReviewAnalysisResult} so a caller can still surface
 *  the evidence gathered before the break. */
export class ReviewAnalysisContractError extends Error {
  readonly result: ReviewAnalysisResult;
  constructor(result: ReviewAnalysisResult) {
    super(
      `review analysis contract broken: ${result.contractErrors.join("; ") || "unknown"}`
    );
    this.name = "ReviewAnalysisContractError";
    this.result = result;
  }
}

const emptySeverity = (): ReviewSeverityCounts => ({
  blocker: 0,
  major: 0,
  minor: 0,
  nit: 0,
  suppressed: 0,
});

/** Synthetic clean result when the panel has nothing to return. */
function cleanPanelResult(agentId?: AgentRuntimeId): StageResult {
  return {
    result: "<review>OK</review>",
    costUsd: 0,
    isError: false,
    apiErrorStatus: null,
    usage: emptyTokenUsage(),
    runtimeId: agentId ?? DEFAULT_AGENT,
  };
}

/**
 * Read-only review analysis (issue P32): lens selection, bounded-concurrent lens
 * execution, merge/dedupe, adversarial verify, mutation guard, low-value
 * suppression, and cleanup — WITHOUT any synth/fix stage. Returns the structured
 * {@link ReviewAnalysisResult}. `runPanel` wraps this for its substrate flow; P32
 * calls it directly. NEVER invokes `review-synth.md`.
 */
export async function analyzeReview(
  opts: ReviewAnalysisOptions
): Promise<ReviewAnalysisResult> {
  const {
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    cooldownMs,
    tokenMode = "off",
    signal,
    agentId,
    resumeNote = "",
    crossTaskSummary,
    onStage,
    recordStage,
  } = opts;
  const verdictSource = opts.verdictSource ?? "file";
  const mutationPolicy = opts.mutationPolicy ?? "restore";
  const strictFindings = opts.strictFindings ?? false;
  const lensStage = opts.lensStage ?? LENS_STAGE;
  const verifyStage = opts.verifyStage ?? VERIFY_STAGE;
  const extraVars = opts.stageVars ?? {};

  const stageResults: StageResult[] = [];
  const contractErrors: string[] = [];
  const makeResult = (
    confirmed: Finding[],
    rejected: Finding[],
    severity: ReviewSeverityCounts
  ): ReviewAnalysisResult => ({
    confirmed,
    rejected,
    severity,
    stageResults,
    contractErrors,
  });
  const breakContract = (
    confirmed: Finding[],
    rejected: Finding[],
    severity: ReviewSeverityCounts
  ): never => {
    throw new ReviewAnalysisContractError(
      makeResult(confirmed, rejected, severity)
    );
  };
  // Fold selected skill usage + input taint evidence into every returned stage
  // result so P32 attribution rides on each lens/verify record. Empty ⇒ identity.
  const decorate = (sr: StageResult): StageResult => {
    let out = sr;
    if (opts.skillUsages?.length) {
      out = {
        ...out,
        skillsUsed: [...(out.skillsUsed ?? []), ...opts.skillUsages],
      };
    }
    if (opts.inputSafetyEvents?.length) {
      out = {
        ...out,
        safetyEvents: [...(out.safetyEvents ?? []), ...opts.inputSafetyEvents],
      };
    }
    return out;
  };
  // Shared executeStage options carrying the P32 read-only plumbing.
  const stageBase = {
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    tokenMode,
    signal,
    agentId,
    sink: opts.sink,
    childEnv: opts.childEnv,
    safetyPolicy: opts.safetyPolicy,
    injectedContext: opts.injectedContext,
  };

  // Router off → the full configured pool (today's behavior); on → risk-routed.
  let lenses = routedLenses(
    opts.changedPaths ?? [],
    opts.lenses,
    opts.adaptiveRouter ?? false
  );
  // A fan-out sub-agent that strayed outside its declared scope needs the
  // structural lens's eyes on it even when the router would otherwise route a
  // narrower subset — but only when `structural` is actually configured.
  if (
    crossTaskSummary?.includes("out-of-scope") &&
    opts.lenses.includes("structural") &&
    !lenses.includes("structural")
  ) {
    lenses = [...lenses, "structural"];
  }
  // Cross-task block prepended to RESUME (not a new template var) — both
  // review-lens.md and review-verify.md already interpolate `{{ RESUME }}` at
  // line 1, so this needs no template change and stays inert (empty string)
  // when there's no fan-out summary.
  const xtaskBlock = formatCrossTaskBlock(crossTaskSummary);
  const resumeWithXtask = xtaskBlock
    ? `${xtaskBlock}\n\n${resumeNote}`
    : resumeNote;
  const isoNow = (): string => new Date().toISOString();
  const panelRel = `panel-${process.pid}-${iteration}-${Date.now()}`;
  const panelHostDir = join(workspaceDir, ".otto-tmp", panelRel);
  mkdirSync(panelHostDir, { recursive: true });

  // Lenses are contractually read-only. Snapshot HEAD so we can detect a lens
  // that edits or commits despite the prompt (it runs bypassPermissions). We only
  // ENFORCE (reset --hard, restore policy) when the worktree starts tracked-clean
  // — otherwise a reset would discard pre-existing user changes.
  const baseHead = git(["rev-parse", "HEAD"], workspaceDir);
  const enforceReadOnly =
    baseHead != null && trackedStatus(workspaceDir) === "";
  if (baseHead != null && !enforceReadOnly && mutationPolicy === "restore") {
    process.stderr.write(
      `${red(SYM.cross)} ${dim("worktree has uncommitted tracked changes — panel lens read-only enforcement disabled (won't risk your changes)")}\n`
    );
  }

  const findingsDirRef = `./${posix.join(".otto-tmp", panelRel)}/`;

  // Under `restore`: reset a read-only sub-agent's tracked mutation (only when the
  // worktree started clean). Under `fail`: any HEAD/tracked/untracked mutation is
  // a contract error.
  const guardMutation = (who: string): void => {
    if (mutationPolicy === "fail") {
      const mutated =
        baseHead != null &&
        (lensMutatedRepo(workspaceDir, baseHead) ||
          worktreeDirty(workspaceDir));
      if (mutated) {
        contractErrors.push(`${who} mutated the repo (read-only violation)`);
        breakContract([], [], emptySeverity());
      }
      return;
    }
    if (enforceReadOnly && lensMutatedRepo(workspaceDir, baseHead)) {
      process.stderr.write(
        `${red(SYM.cross)} ${dim(`${who} mutated the repo (read-only violation) — restoring to ${baseHead!.slice(0, 8)}`)}\n`
      );
      git(["reset", "--hard", baseHead!], workspaceDir);
    }
  };

  try {
    // 1. Lenses — independent read-only reviews of the same HEAD, bounded-parallel.
    phaseLine(`${lenses.length} lenses (parallel): ${lenses.join(", ")}`);
    const lensStartedAt = isoNow();
    const results = await boundedMap(lenses, LENS_CONCURRENCY, (lens) =>
      executeStage({
        ...stageBase,
        stage: { ...lensStage, tier: tierForLens(lens) },
        vars: { LENS: lens, RESUME: resumeWithXtask, ...extraVars },
        logLabel: `lens-${lens}`,
        modelRouting: opts.modelRouting,
        tierLadder: opts.tierLadder,
        riskAssessment: opts.riskAssessment,
      }).then((sr) => ({ lens, sr: decorate(sr) }))
    );
    // One reset for the whole batch (or a contract error under `fail`).
    guardMutation("lenses");

    // Emit evidence + budget control in lens-INDEX order (deterministic).
    let stop = false;
    let cooldownFactor = 1;
    let malformedFindings = 0;
    for (const { lens, sr } of results) {
      stageResults.push(sr);
      if (sr.isError) {
        contractErrors.push(`lens ${lens} returned an error result`);
        breakContract([], [], emptySeverity());
      }
      const parsed = parseFindings(sr.result, lens);
      malformedFindings += parsed.dropped;
      outcomeLine(
        /<lens>\s*SKIP\s*<\/lens>/i.test(sr.result.trim())
          ? "skipped (no commit)"
          : `${parsed.findings.length} finding${parsed.findings.length === 1 ? "" : "s"}`
      );
      recordStage?.(lens, sr, lensStartedAt);
      const ctrl = onStage?.(sr) ?? { stop: false, cooldownFactor: 1 };
      if (ctrl.stop) stop = true;
      cooldownFactor = Math.max(cooldownFactor, ctrl.cooldownFactor);
    }
    // Strict mode fails on any malformed finding row; panel mode already dropped
    // (and counted) it above without failing.
    if (strictFindings && malformedFindings > 0) {
      contractErrors.push(`${malformedFindings} malformed finding row(s)`);
      breakContract([], [], emptySeverity());
    }
    if (stop) {
      // Budget exhausted — skip verify, return the analysis so far (no confirmed).
      return makeResult([], [], emptySeverity());
    }

    // Merge + dedupe across lenses into one findings-merged.md (the verifier
    // globs findings-*.md, so one file is read exactly once).
    const { findings } = mergeLensFindings(
      results.map((r) => ({ lens: r.lens, text: r.sr.result }))
    );
    const candidateCounts = severityCounts(findings);
    if (findings.length === 0) {
      // Nothing to verify — a clean analysis.
      outcomeLine("no findings — skipping verify");
      return makeResult([], [], emptySeverity());
    }
    // The merged candidate findings, as pipe-delimited wire rows. Written to
    // findings-merged.md (globbed via FINDINGS_DIR by the substrate verifier) AND
    // exposed as the `CANDIDATE_FINDINGS` var so a template can inline them
    // directly (the P32 `pr-review-verify.md` contract). The substrate
    // `review-verify.md` ignores CANDIDATE_FINDINGS, so this is inert there.
    const candidateFindingsWire = findings.map(findingToWire).join("\n");
    writeFileSync(
      join(panelHostDir, "findings-merged.md"),
      candidateFindingsWire + "\n",
      "utf8"
    );
    if (cooldownMs > 0) await sleep(cooldownMs * cooldownFactor, signal);

    // 2. Adversarial verify — a skeptic refutes the candidate findings.
    phaseLine("adversarial verify");
    const verifyStartedAt = isoNow();
    const verify = decorate(
      await executeStage({
        ...stageBase,
        stage: verifyStage,
        vars: {
          FINDINGS_DIR: findingsDirRef,
          CANDIDATE_FINDINGS: candidateFindingsWire,
          RESUME: resumeWithXtask,
          ...extraVars,
        },
        logLabel: "verify",
      })
    );
    guardMutation("verify");
    stageResults.push(verify);
    if (verify.isError) {
      contractErrors.push("verifier returned an error result");
      breakContract([], [], emptySeverity());
    }
    recordStage?.(verifyStage.name, verify, verifyStartedAt, candidateCounts);

    if (verdictSource === "result") {
      // P32 flow: parse verdicts straight from the verifier's returned text —
      // no verdicts.md is read or required.
      const parse = parseReviewVerdicts(verify.result, findings);
      const vctrl = onStage?.(verify) ?? { stop: false, cooldownFactor: 1 };
      if (vctrl.stop) return makeResult([], [], emptySeverity());
      const counts = severityCounts(parse.confirmed);
      const kept = suppressLowValue(parse.confirmed).kept;
      if (parse.errors.length > 0) {
        // Strict: any malformed/missing/duplicate/unmatched verdict fails.
        contractErrors.push(...parse.errors);
        breakContract(kept, parse.rejected, counts);
      }
      if (kept.length > 0 && cooldownMs > 0) {
        await sleep(cooldownMs * vctrl.cooldownFactor, signal);
      }
      return makeResult(kept, parse.rejected, counts);
    }

    // Default (substrate) flow: the verifier wrote verdicts.md. Its existence +
    // CONFIRMED count gate the fix stage, preserving today's behavior.
    const verdicts = readVerdicts(panelHostDir);
    if (verdicts.exists) {
      outcomeLine(
        `${verdicts.confirmed} confirmed, ${verdicts.rejected} rejected`
      );
    } else {
      outcomeLine("verifier wrote no verdicts.md (contract violation)", false);
    }
    const vctrl = onStage?.(verify) ?? { stop: false, cooldownFactor: 1 };
    if (vctrl.stop) return makeResult([], [], emptySeverity()); // budget spent
    if (!verdicts.exists) {
      outcomeLine("skipping synth — no validated verdicts to act on", false);
      return makeResult([], [], emptySeverity());
    }
    // The verifier's own verdicts.md is authoritative on CONFIRMED count here.
    // The candidate findings stand in as the confirmed set only for the gate +
    // severity tally; the substrate synth is handed the verifier's ORIGINAL
    // verdicts.md (its real CONFIRMED/REJECTED split) so it fixes only the
    // confirmed subset. No CONFIRMED ⇒ nothing to fix.
    const allConfirmed = verdicts.confirmed > 0 ? findings : [];
    const counts = severityCounts(allConfirmed);
    const kept = suppressLowValue(allConfirmed).kept;
    // Capture the verifier's real verdicts.md now — `finally` deletes panelHostDir
    // before runPanelSynth runs.
    let verifierVerdicts: string | undefined;
    if (kept.length > 0) {
      try {
        verifierVerdicts = readFileSync(
          join(panelHostDir, "verdicts.md"),
          "utf8"
        );
      } catch {
        verifierVerdicts = undefined;
      }
    }
    if (kept.length > 0 && cooldownMs > 0) {
      await sleep(cooldownMs * vctrl.cooldownFactor, signal);
    }
    return { ...makeResult(kept, [], counts), verifierVerdicts };
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}

/** Synthesize & fix the CONFIRMED findings in one `fix(review:)` commit. Hands
 *  synth the verifier's ORIGINAL verdicts.md (its true CONFIRMED/REJECTED split)
 *  via `analysis.verifierVerdicts`, so CONFIRMED-only semantics are preserved and
 *  rejected findings are never presented as CONFIRMED. Runs the existing
 *  `review-synth.md`, retaining today's onStage/recordStage/commit-status. */
async function runPanelSynth(
  opts: RunPanelOptions,
  analysis: ReviewAnalysisResult
): Promise<StageResult> {
  const {
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    tokenMode = "off",
    signal,
    agentId,
    resumeNote = "",
    onStage,
    recordStage,
  } = opts;
  const synthRel = `panel-synth-${process.pid}-${iteration}-${Date.now()}`;
  const synthHostDir = join(workspaceDir, ".otto-tmp", synthRel);
  mkdirSync(synthHostDir, { recursive: true });
  const findingsDirRef = `./${posix.join(".otto-tmp", synthRel)}/`;
  const baseHead = git(["rev-parse", "HEAD"], workspaceDir);
  try {
    // Faithful CONFIRMED-only semantics: synth reads the verifier's ORIGINAL
    // verdicts.md (its real CONFIRMED + REJECTED lines), so it fixes only the
    // confirmed subset and ignores rejected false positives. Fall back to
    // reconstructing CONFIRMED lines from the kept findings only when the
    // verifier's text wasn't captured (e.g. a non-file verdict source).
    const verdictsText =
      analysis.verifierVerdicts ??
      analysis.confirmed
        .map((f) => `CONFIRMED ${findingToWire(f)}`)
        .join("\n") + "\n";
    writeFileSync(join(synthHostDir, "verdicts.md"), verdictsText, "utf8");
    phaseLine("synthesize & fix");
    const synthStartedAt = new Date().toISOString();
    const synth = await executeStage({
      stage: SYNTH_STAGE,
      vars: { FINDINGS_DIR: findingsDirRef, RESUME: resumeNote },
      workspaceDir,
      packageDir,
      iteration,
      maxRetries,
      tokenMode,
      signal,
      agentId,
      logLabel: "synth",
    });
    // Report from real signals: HEAD movement AND worktree cleanliness.
    const after = git(["rev-parse", "HEAD"], workspaceDir);
    const committed = baseHead != null && after != null && after !== baseHead;
    const dirty = worktreeDirty(workspaceDir);
    const subject =
      git(["log", "-1", "--pretty=%s"], workspaceDir) ?? "fix(review)";
    if (committed && !dirty) {
      outcomeLine(`committed: ${subject}`);
    } else if (committed && dirty) {
      outcomeLine(
        `committed: ${subject} — but uncommitted changes remain`,
        false
      );
    } else if (dirty) {
      outcomeLine(
        "synth edited the worktree but did not commit — left dirty",
        false
      );
    } else {
      outcomeLine("clean — no fix needed");
    }
    recordStage?.(SYNTH_STAGE.name, synth, synthStartedAt, analysis.severity);
    onStage?.(synth);
    return synth;
  } finally {
    rmSync(synthHostDir, { recursive: true, force: true });
  }
}

/** Harness-orchestrated reviewer panel: read-only lens analysis → one synth
 *  fix(review) commit, but only when adversarially-confirmed findings survive. */
export async function runPanel(opts: RunPanelOptions): Promise<StageResult> {
  let analysis: ReviewAnalysisResult;
  try {
    analysis = await analyzeReview({
      ...opts,
      verdictSource: "file",
      mutationPolicy: "restore",
    });
  } catch (error) {
    if (!(error instanceof ReviewAnalysisContractError)) throw error;
    return error.result.stageResults.at(-1) ?? cleanPanelResult(opts.agentId);
  }
  if (analysis.confirmed.length === 0) {
    return analysis.stageResults.at(-1) ?? cleanPanelResult(opts.agentId);
  }
  return runPanelSynth(opts, analysis);
}
