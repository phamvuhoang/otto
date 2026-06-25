import type { StageFamily } from "./skill-activation.js";
import { classifyRisk } from "./risk.js";
import type { SkillUsage } from "./run-report.js";
import { needsRevalidation } from "./skill-validation.js";
import { globMatch, type Skill } from "./skills.js";

/**
 * Stage-scoped skill retrieval (issue #137 P18). Given the skills installed under
 * `.otto/skills/`, the running stage, and the iteration's changed files, decide
 * which **validated, compatible, relevant** skills to inject — bounded by a hard
 * char budget so skill text can never crowd out the real prompt.
 *
 * Eligibility keys on the P17 static gate, NOT the older run-validation:
 * a skill is selectable only when it carries a recorded `compatibility` that is
 * neither `blocked` nor `interactive-only` (AFK is non-interactive), its body has
 * not drifted since validation (`needsRevalidation`), and its scope fits the
 * stage — `afk-safe` anywhere, `stage-scoped` only on its declared stages. Among
 * eligible skills, relevance is scored by scope-glob match against the changed
 * files and specificity; a skill whose constraints forbid the change's risk class
 * is excluded. Pure, deterministic — the loop does the injection + evidence.
 */

/** Default total char budget for all injected skill text in one stage. */
export const DEFAULT_SKILLS_BUDGET_CHARS = 4000;
/** Default per-skill excerpt cap, so one skill cannot consume the whole budget. */
export const DEFAULT_PER_SKILL_CHARS = 1200;

/** Map a concrete stage name (`stages.ts`) to its family, or null if unknown. */
export function stageFamily(stageName: string): StageFamily | null {
  const n = stageName.toLowerCase();
  // "apply-review-implementer" contains both — implement wins (it writes code).
  if (n.includes("implement")) return "implement";
  if (n === "verifier") return "implement";
  if (n === "plan") return "plan";
  if (n.includes("review")) return "review";
  if (n.includes("report")) return "report";
  if (n.includes("journal")) return "journal";
  return null;
}

/** One skill's routing verdict — for `otto-skills why --stage`. */
export type SkillRouteVerdict = {
  name: string;
  eligible: boolean;
  selected: boolean;
  score: number;
  reasons: string[];
};

/** A selected skill plus its bounded excerpt and char cost. */
export type SkillRouteSelection = {
  skill: Skill;
  reasons: string[];
  /** Bounded instruction excerpt (never the full library). */
  excerpt: string;
  chars: number;
};

/** The result of routing skills for one stage. */
export type SkillRouteResult = {
  family: StageFamily | null;
  /** Selected skills, highest-ranked first, within the char budget. */
  selected: SkillRouteSelection[];
  /** Every skill considered, with eligibility + reasons. */
  verdicts: SkillRouteVerdict[];
  budgetChars: number;
  usedChars: number;
};

/** Trim a skill body to a char cap, cutting on a line boundary when possible. */
export function boundExcerpt(
  instructions: string,
  cap: number = DEFAULT_PER_SKILL_CHARS
): string {
  const body = instructions.trim();
  if (body.length <= cap) return body;
  const slice = body.slice(0, cap);
  const lastNl = slice.lastIndexOf("\n");
  const cut = lastNl > cap * 0.5 ? slice.slice(0, lastNl) : slice;
  return cut.trimEnd() + "\n…";
}

type Scored = {
  skill: Skill;
  score: number;
  reasons: string[];
};

/** Decide eligibility for `skill` on `family`, accumulating human reasons. */
function assess(
  skill: Skill,
  family: StageFamily | null,
  changedPaths: string[],
  now: Date | undefined
): { eligible: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const v = skill.validation;

  if (!v.compatibility) {
    return {
      eligible: false,
      score: 0,
      reasons: [
        "not validated (no compatibility recorded — run otto-skills validate)",
      ],
    };
  }
  if (v.compatibility === "blocked") {
    return {
      eligible: false,
      score: 0,
      reasons: ["blocked by the validation gate"],
    };
  }
  if (v.compatibility === "interactive-only") {
    return {
      eligible: false,
      score: 0,
      reasons: ["interactive-only — needs a human, unsafe for AFK stages"],
    };
  }
  if (needsRevalidation(skill)) {
    return {
      eligible: false,
      score: 0,
      reasons: [
        "body drifted since validation — needs revalidation before reuse",
      ],
    };
  }
  if (family === null) {
    return { eligible: false, score: 0, reasons: ["unknown stage family"] };
  }

  let score = 0;
  if (v.compatibility === "stage-scoped") {
    if (!(v.stages ?? []).includes(family)) {
      return {
        eligible: false,
        score: 0,
        reasons: [
          `stage-scoped to ${(v.stages ?? []).join(", ") || "(none)"} — not ${family}`,
        ],
      };
    }
    score += 1; // a skill scoped to exactly this stage is more specific than afk-safe
    reasons.push(`stage-scoped to ${family}`);
  } else {
    reasons.push("afk-safe (usable on any stage)");
  }

  // Risk-class exclusion + scope-glob relevance against the changed files.
  if (changedPaths.length > 0) {
    const assessment = classifyRisk(changedPaths);
    const forbidden = skill.constraints.some((c) =>
      c.toLowerCase().includes(assessment.class)
    );
    if (forbidden) {
      return {
        eligible: false,
        score: 0,
        reasons: [
          `excluded by constraint for risk class "${assessment.class}"`,
        ],
      };
    }
    if (skill.scope.length === 0) {
      score += 1;
      reasons.push("repo-wide (no scope restriction)");
    } else {
      const hit = changedPaths.filter((p) =>
        skill.scope.some((g) => globMatch(g, p))
      );
      if (hit.length > 0) {
        score += 2;
        reasons.push(`scope matches changed file(s): ${hit.join(", ")}`);
      } else {
        reasons.push("scope does not match the changed files");
      }
    }
  }

  return { eligible: true, score, reasons };
}

/**
 * Route skills for a stage: assess each, rank eligible ones (score desc, then
 * name), then greedily fill the char budget with bounded excerpts. Returns the
 * selection (for injection), the full verdict list (for `why --stage`), and the
 * char accounting. A skill that does not fit the remaining budget is dropped with
 * a reason rather than truncated mid-excerpt. Pure.
 */
export function routeSkillsForStage(
  skills: Skill[],
  opts: {
    stageName: string;
    changedPaths?: string[];
    budgetChars?: number;
    perSkillChars?: number;
    now?: Date;
  }
): SkillRouteResult {
  const family = stageFamily(opts.stageName);
  const changedPaths = opts.changedPaths ?? [];
  const budgetChars = opts.budgetChars ?? DEFAULT_SKILLS_BUDGET_CHARS;
  const perSkillChars = opts.perSkillChars ?? DEFAULT_PER_SKILL_CHARS;

  const eligible: Scored[] = [];
  const verdicts: SkillRouteVerdict[] = [];

  for (const skill of skills) {
    const a = assess(skill, family, changedPaths, opts.now);
    verdicts.push({
      name: skill.name,
      eligible: a.eligible,
      selected: false,
      score: a.score,
      reasons: a.reasons,
    });
    if (a.eligible)
      eligible.push({ skill, score: a.score, reasons: a.reasons });
  }

  eligible.sort(
    (x, y) => y.score - x.score || x.skill.name.localeCompare(y.skill.name)
  );

  const selected: SkillRouteSelection[] = [];
  let usedChars = 0;
  for (const e of eligible) {
    const excerpt = boundExcerpt(e.skill.instructions, perSkillChars);
    const verdict = verdicts.find((v) => v.name === e.skill.name)!;
    if (usedChars + excerpt.length > budgetChars) {
      verdict.reasons.push("dropped: over the per-stage skill char budget");
      continue;
    }
    usedChars += excerpt.length;
    verdict.selected = true;
    selected.push({
      skill: e.skill,
      reasons: e.reasons,
      excerpt,
      chars: excerpt.length,
    });
  }

  return { family, selected, verdicts, budgetChars, usedChars };
}

/** A short attribution string for a skill: source/ref + version (issue #138). */
function attribution(skill: Skill): string {
  const p = skill.provenance;
  if (p) {
    const ref = p.upstreamRef ? ` @${p.upstreamRef}` : "";
    const sum = (skill.validation.instructionsChecksum ?? p.checksum).slice(
      0,
      12
    );
    return `source: ${p.source}${ref}, v${skill.version}, sha256 ${sum}`;
  }
  const sum = (skill.validation.instructionsChecksum ?? "").slice(0, 12);
  return `source: repo, v${skill.version}${sum ? `, sha256 ${sum}` : ""}`;
}

/** Standing precedence + conflict guidance prepended to every injected block. */
const INJECTION_NOTE =
  "Advisory process context. Repo AGENTS instructions, Otto stage contracts, and " +
  ".otto/policy.json outrank these skills. If a skill conflicts with repo policy " +
  "or a more specific instruction, follow repo policy and note the conflict — do " +
  "not silently mix both.";

/**
 * Render selected skills into a bounded, attributed `<available-skills>` block
 * for prompt injection (issue #138). Each skill is labelled with its source, ref,
 * version, and checksum so a report can trace exactly which instruction shaped the
 * run. The block carries a standing note that repo policy + stage contracts
 * outrank skills and that conflicts must be reported, not silently merged. Returns
 * `""` when nothing is selected, so an opted-in stage with no eligible skill is
 * byte-for-byte unchanged. Pure.
 */
export function formatSkillInjection(selected: SkillRouteSelection[]): string {
  if (selected.length === 0) return "";
  const lines: string[] = [`<available-skills note="${INJECTION_NOTE}">`];
  for (const s of selected) {
    lines.push(`### ${s.skill.name} (${attribution(s.skill)})`);
    lines.push(s.excerpt);
    lines.push("");
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}

/**
 * Convert selections into `SkillUsage[]` evidence (issue #139): name, version,
 * source, ref, the stage that consumed them, and the retrieval reasons — so a run
 * report can reproduce why each skill was selected from the bundle alone. Pure.
 */
export function toSkillUsages(
  selected: SkillRouteSelection[],
  stage: string
): SkillUsage[] {
  return selected.map((s) => {
    const u: SkillUsage = {
      name: s.skill.name,
      version: s.skill.version,
      stage,
      reasons: s.reasons,
    };
    if (s.skill.provenance) {
      u.source = s.skill.provenance.source;
      if (s.skill.provenance.upstreamRef)
        u.ref = s.skill.provenance.upstreamRef;
    } else {
      u.source = "repo";
    }
    return u;
  });
}
