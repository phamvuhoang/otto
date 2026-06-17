import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { AgentRuntimeId } from "./agent-runtime.js";
import { git } from "./git.js";
import { executeStage } from "./stage-exec.js";
import { sleep } from "./pacing.js";
import type { StageResult } from "./runner.js";
import { bold, dim, green, red, SYM } from "./stream-render.js";
import type { TokenMode } from "./tokens.js";

const LENS_STAGE = {
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

/** Human count of a lens's findings from its free-form output ("skip" = no commit to review). */
function findingsNote(result: string): string {
  const t = result.trim();
  if (/<lens>\s*SKIP\s*<\/lens>/i.test(t)) return "skipped (no commit)";
  const n = t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l)).length;
  if (n === 0) return "no findings";
  return `${n} finding${n === 1 ? "" : "s"}`;
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
  /** Active runtime id; threaded into each sub-stage so panel logs are runtime-labelled. */
  agentId?: AgentRuntimeId;
  /**
   * Called after every panel sub-agent (each lens + synth) so the loop owns
   * budget + adaptive pacing for them too. Returns whether the budget is now
   * exhausted (stop the panel) and the current adaptive cooldown factor.
   */
  onStage?: (sr: StageResult) => PanelStageControl;
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
    lenses,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    cooldownMs,
    tokenMode = "off",
    signal,
    agentId,
    onStage,
  } = opts;
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
    // 1. Lenses — each finds defects through one lens, read-only.
    for (let i = 0; i < lenses.length; i++) {
      const lens = lenses[i];
      phaseLine(`${lens} lens (${i + 1}/${lenses.length})`);
      const sr = await executeStage({
        stage: LENS_STAGE,
        vars: { LENS: lens },
        workspaceDir,
        packageDir,
        iteration,
        maxRetries,
        tokenMode,
        signal,
        agentId,
        logLabel: `lens-${lens}`,
      });
      restoreIfMutated(`lens ${lens}`);
      writeFileSync(
        join(panelHostDir, `findings-${lens}.md`),
        sr.result,
        "utf8"
      );
      outcomeLine(findingsNote(sr.result));

      const ctrl = onStage?.(sr) ?? { stop: false, cooldownFactor: 1 };
      if (ctrl.stop) return sr; // budget exhausted — skip remaining lenses + verify + synth
      if (cooldownMs > 0) await sleep(cooldownMs * ctrl.cooldownFactor, signal);
    }

    // 2. Adversarial verify — a skeptic refutes the lens findings, writing
    //    verdicts.md (CONFIRMED/REJECTED) so synth only fixes survivors.
    phaseLine("adversarial verify");
    const verify = await executeStage({
      stage: VERIFY_STAGE,
      vars: { FINDINGS_DIR: findingsDirRef },
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
    const synth = await executeStage({
      stage: SYNTH_STAGE,
      vars: { FINDINGS_DIR: findingsDirRef },
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
    onStage?.(synth);
    return synth;
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}
