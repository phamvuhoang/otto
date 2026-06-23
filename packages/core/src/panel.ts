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
  parseFindings,
  severityCounts,
  type Finding,
} from "./review-severity.js";
import type { StageResult } from "./runner.js";
import type { Stage } from "./stages.js";
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
export function mergeLensFindings(
  files: { lens: string; text: string }[]
): { findings: Finding[]; total: number } {
  const all: Finding[] = [];
  for (const { lens, text } of files)
    all.push(...parseFindings(text, lens).findings);
  return { findings: dedupeFindings(all), total: all.length };
}

/** Serialize a deduped finding back to a wire-format line:
 *  `SEVERITY | file:line | claim | why | fix?` (the trailing `| fix` is omitted
 *  when there is no suggested fix). The verifier globs `findings-*.md`, so the
 *  single merged file matches and is read exactly once. */
function findingToWire(f: Finding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  const head = `${f.severity} | ${loc} | ${f.claim} | ${f.why}`;
  return f.suggestedFix ? `${head} | ${f.suggestedFix}` : head;
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
    reviewSeverity?: { blocker: number; major: number; minor: number; nit: number; suppressed: number }
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

/** Harness-orchestrated reviewer panel: read-only lens reviews → one synth fix(review) commit. */
export async function runPanel(opts: RunPanelOptions): Promise<StageResult> {
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
    onStage,
    recordStage,
  } = opts;
  // Router off → the full configured pool (today's behavior); on → risk-routed.
  const lenses = routedLenses(
    opts.changedPaths ?? [],
    opts.lenses,
    opts.adaptiveRouter ?? false
  );
  const isoNow = (): string => new Date().toISOString();
  const panelRel = `panel-${process.pid}-${iteration}-${Date.now()}`;
  const panelHostDir = join(workspaceDir, ".otto-tmp", panelRel);
  mkdirSync(panelHostDir, { recursive: true });

  // Lenses are contractually read-only; synth owns the single fix(review:) commit.
  // Snapshot HEAD so we can detect + undo a lens that edits or commits despite the
  // prompt (it runs bypassPermissions, so the OS would let it). We only ENFORCE
  // (reset --hard) when the worktree starts tracked-clean — otherwise a reset would
  // discard pre-existing uncommitted user changes, so we disable the guard and warn.
  const baseHead = git(["rev-parse", "HEAD"], workspaceDir);
  const enforceReadOnly =
    baseHead != null && trackedStatus(workspaceDir) === "";
  if (baseHead != null && !enforceReadOnly) {
    process.stderr.write(
      `${red(SYM.cross)} ${dim("worktree has uncommitted tracked changes — panel lens read-only enforcement disabled (won't risk your changes)")}\n`
    );
  }

  const findingsDirRef = `./${posix.join(".otto-tmp", panelRel)}/`;

  // Restore HEAD if a contractually read-only sub-agent (lens or verifier)
  // committed or edited tracked files despite the prompt. Only safe when the
  // worktree started clean, so reset --hard can discard only the sub-agent's
  // own changes — never pre-existing work. Returns true if it had to restore.
  const restoreIfMutated = (who: string): boolean => {
    if (enforceReadOnly && lensMutatedRepo(workspaceDir, baseHead)) {
      process.stderr.write(
        `${red(SYM.cross)} ${dim(`${who} mutated the repo (read-only violation) — restoring to ${baseHead!.slice(0, 8)}`)}\n`
      );
      git(["reset", "--hard", baseHead!], workspaceDir);
      return true;
    }
    return false;
  };

  try {
    // 1. Lenses — each finds defects through one lens, read-only. Run them
    //    concurrently (bounded) since they are independent reads of the same
    //    HEAD. The per-lens reset guard is UNSAFE while siblings run, so we do
    //    NOT restore inside the parallel region — the worktree started
    //    tracked-clean (when enforceReadOnly), so a single end-of-batch reset
    //    below undoes any read-only violation by any lens before verify runs.
    phaseLine(`${lenses.length} lenses (parallel): ${lenses.join(", ")}`);
    const lensStartedAt = isoNow();
    // boundedMap preserves input (lens-index) order in `results`.
    const results = await boundedMap(lenses, LENS_CONCURRENCY, (lens) =>
      executeStage({
        stage: { ...LENS_STAGE, tier: tierForLens(lens) },
        vars: { LENS: lens, RESUME: resumeNote },
        workspaceDir,
        packageDir,
        iteration,
        maxRetries,
        tokenMode,
        signal,
        agentId,
        logLabel: `lens-${lens}`,
        modelRouting: opts.modelRouting,
        tierLadder: opts.tierLadder,
        riskAssessment: opts.riskAssessment,
      }).then((sr) => ({ lens, sr }))
    );
    // One reset for the whole batch: undoes any tracked mutation/commit a lens
    // made in violation of the read-only contract, before the verifier reads.
    restoreIfMutated("lenses");

    // Emit evidence + budget control in lens-INDEX order (deterministic), even
    // though the agents ran concurrently. onStage still owns the budget stop —
    // but since every lens already ran, a stop just skips verify + synth.
    let stop = false;
    let cooldownFactor = 1;
    for (const { lens, sr } of results) {
      const parsed = parseFindings(sr.result, lens).findings.length;
      outcomeLine(
        /<lens>\s*SKIP\s*<\/lens>/i.test(sr.result.trim())
          ? "skipped (no commit)"
          : `${parsed} finding${parsed === 1 ? "" : "s"}`
      );
      recordStage?.(lens, sr, lensStartedAt);
      const ctrl = onStage?.(sr) ?? { stop: false, cooldownFactor: 1 };
      if (ctrl.stop) stop = true;
      // Lenses ran concurrently, so there is one batch cooldown — pace it by the
      // most-throttled lens (max factor) to honor adaptive backoff.
      cooldownFactor = Math.max(cooldownFactor, ctrl.cooldownFactor);
    }
    if (stop) {
      // Budget exhausted — skip verify + synth, return the last lens result.
      return results[results.length - 1].sr;
    }

    // Merge + dedupe across lenses into a single findings-merged.md so the
    // verifier (which globs findings-*.md) reads each issue exactly once. We
    // deliberately do NOT also write per-lens findings-<lens>.md files — both
    // would double-count under the glob.
    const { findings } = mergeLensFindings(
      results.map((r) => ({ lens: r.lens, text: r.sr.result }))
    );
    const counts = severityCounts(findings);
    if (findings.length === 0) {
      // Nothing to verify or fix — return a synthetic clean result.
      outcomeLine("no findings — skipping verify + synth");
      return {
        result: "<review>OK</review>",
        costUsd: 0,
        isError: false,
        apiErrorStatus: null,
        usage: emptyTokenUsage(),
        runtimeId: agentId ?? DEFAULT_AGENT,
      };
    }
    writeFileSync(
      join(panelHostDir, "findings-merged.md"),
      findings.map(findingToWire).join("\n") + "\n",
      "utf8"
    );
    if (cooldownMs > 0) await sleep(cooldownMs * cooldownFactor, signal);

    // 2. Adversarial verify — a skeptic refutes the lens findings, writing
    //    verdicts.md (CONFIRMED/REJECTED) so synth only fixes survivors.
    phaseLine("adversarial verify");
    const verifyStartedAt = isoNow();
    const verify = await executeStage({
      stage: VERIFY_STAGE,
      vars: { FINDINGS_DIR: findingsDirRef, RESUME: resumeNote },
      workspaceDir,
      packageDir,
      iteration,
      maxRetries,
      tokenMode,
      signal,
      agentId,
      logLabel: "verify",
    });
    restoreIfMutated("verify");
    recordStage?.(VERIFY_STAGE.name, verify, verifyStartedAt, counts);
    const verdicts = readVerdicts(panelHostDir);
    if (verdicts.exists) {
      outcomeLine(
        `${verdicts.confirmed} confirmed, ${verdicts.rejected} rejected`
      );
    } else {
      outcomeLine("verifier wrote no verdicts.md (contract violation)", false);
    }

    const vctrl = onStage?.(verify) ?? { stop: false, cooldownFactor: 1 };
    if (vctrl.stop) return verify; // budget exhausted — skip synth

    // Contract gate: the verifier MUST write verdicts.md (the template emits
    // `none` when there were no findings). Its absence means synth would run
    // with no validated input — so skip the fix stage rather than let synth
    // patch from unverified findings. Forward progress is preserved: the
    // implementer's commit stands, just unreviewed this iteration.
    if (!verdicts.exists) {
      outcomeLine("skipping synth — no validated verdicts to act on", false);
      return verify;
    }
    if (cooldownMs > 0) await sleep(cooldownMs * vctrl.cooldownFactor, signal);

    // 3. Synth — fix only CONFIRMED findings in one fix(review:) commit.
    phaseLine("synthesize & fix");
    const synthStartedAt = isoNow();
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
    // Report from real signals: HEAD movement AND worktree cleanliness. A bare
    // HEAD check would call an edit-without-commit (or a `commit -am` that missed
    // a new file) "clean" — surface the dirty tree instead of hiding it.
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
    recordStage?.(SYNTH_STAGE.name, synth, synthStartedAt, counts);
    onStage?.(synth);
    return synth;
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}
