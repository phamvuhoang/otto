import { createHash } from "node:crypto";

import { parseFrontmatter } from "./external-skills.js";
import { toSkillName, type Skill, type SkillCompatibility } from "./skills.js";

/**
 * Skill compatibility & validation gate (issue #113 P17). Before an imported or
 * repo-authored skill is eligible to influence a live run, it must pass a gate:
 * static manifest lint, frontmatter/capability extraction, license/provenance
 * checks (this slice, #132), an instruction-risk scan (#133), and a derived
 * compatibility class persisted back to `skill.json` (#134).
 *
 * This module is **pure** — no fs, no model, deterministic over a {@link Skill}
 * value — mirroring `skills.ts`/`safety-policy.ts`. The bin reads a skill, runs
 * {@link validateSkill}, and prints the report; persistence and selection are
 * separate concerns layered on later. Validation never makes a skill eligible by
 * itself: "validated" means "passed the gate", not "auto-applied".
 */

/** Severity of one validation finding. `error` blocks; `warn`/`info` advise. */
export type SkillCheckSeverity = "error" | "warn" | "info";

/** Which axis of the gate a finding came from. */
export type SkillCheckKind = "manifest" | "provenance" | "risk";

/**
 * One validation finding. `rule` is the stable check id (for tests + remediation
 * lookup); `message` says what is wrong; `remediation` says how to fix it — the
 * issue's "failures explain the exact blocker + remediation path".
 */
export type SkillCheckFinding = {
  kind: SkillCheckKind;
  severity: SkillCheckSeverity;
  rule: string;
  message: string;
  remediation: string;
};

/** The aggregate result of validating one skill. */
export type SkillValidationReport = {
  /** Skill name validated. */
  skill: string;
  /** Capabilities extracted from the manifest + instruction frontmatter. */
  capabilities: string[];
  findings: SkillCheckFinding[];
  /**
   * True when no `error`-severity finding fired AND no applicable behavior drill
   * failed — the skill clears the gate.
   */
  ok: boolean;
  /** Derived compatibility class (issue #134). */
  compatibility: SkillCompatibility;
  /** Stages a `stage-scoped` skill is valid for; empty otherwise. */
  stages: string[];
  /** sha256 of the instruction body validated (for drift detection, #135). */
  checksum: string;
  /** Behavior-drill outcomes (issue #135). */
  drills: DrillResult[];
};

/** sha256 of a skill's instruction body, hex. The hash domain matches the */
/** imported-package checksum in `external-skills.ts` so drift compares cleanly. */
export function skillChecksum(instructions: string): string {
  return createHash("sha256").update(instructions).digest("hex");
}

/**
 * Map one capability tag to the stage it scopes to, or null when it does not
 * imply a specific stage (a general capability → afk-safe, not stage-scoped).
 * Mirrors the P18 stage capability tags in the roadmap.
 */
const CAPABILITY_STAGE: ReadonlyMap<string, string> = new Map([
  ["planning", "plan"],
  ["roadmap-planning", "plan"],
  ["prd", "plan"],
  ["prioritization", "plan"],
  ["problem-framing", "plan"],
  ["discovery", "plan"],
  ["tdd", "implement"],
  ["coding", "implement"],
  ["refactor", "implement"],
  ["code-review", "review"],
  ["review", "review"],
  ["security", "review"],
  ["structural", "review"],
  ["reporting", "report"],
  ["report", "report"],
  ["journal", "journal"],
  ["context-engineering", "tool-output"],
  ["compression", "tool-output"],
]);

/** The stages a skill's capabilities imply (sorted, de-duplicated). */
function impliedStages(capabilities: string[]): string[] {
  const stages = new Set<string>();
  for (const cap of capabilities) {
    const stage = CAPABILITY_STAGE.get(cap.toLowerCase());
    if (stage) stages.add(stage);
  }
  return [...stages].sort();
}

/**
 * Derive a {@link SkillCompatibility} class from a validation report (issue
 * #134), as a priority ladder: an error-severity finding → `blocked` (cannot be
 * applied anywhere); an interactive hard stop → `interactive-only` (needs a human,
 * so AFK-unsafe even when otherwise valid); capabilities that imply specific
 * stages → `stage-scoped` (with the stage list); otherwise `afk-safe`. Pure.
 */
export function classifyCompatibility(report: SkillValidationReport): {
  compatibility: SkillCompatibility;
  stages: string[];
} {
  if (report.findings.some((f) => f.severity === "error")) {
    return { compatibility: "blocked", stages: [] };
  }
  if (report.findings.some((f) => f.rule === "interactive-hard-stop")) {
    return { compatibility: "interactive-only", stages: [] };
  }
  const stages = impliedStages(report.capabilities);
  if (stages.length > 0) {
    return { compatibility: "stage-scoped", stages };
  }
  return { compatibility: "afk-safe", stages: [] };
}

/**
 * Static manifest/schema lint. Checks the structural invariants a usable skill
 * package must hold: a filesystem-safe name, a non-empty instruction body, at
 * least one capability (the retrieval key), and a set version. Returns one
 * finding per broken rule; a well-formed manifest yields `[]`.
 */
export function lintManifest(skill: Skill): SkillCheckFinding[] {
  const findings: SkillCheckFinding[] = [];

  if (toSkillName(skill.name) !== skill.name) {
    findings.push({
      kind: "manifest",
      severity: "error",
      rule: "name-slug",
      message: `name "${skill.name}" is not a filesystem-safe slug`,
      remediation: `rename the package to "${toSkillName(skill.name)}"`,
    });
  }

  if (skill.instructions.trim().length === 0) {
    findings.push({
      kind: "manifest",
      severity: "error",
      rule: "empty-instructions",
      message: "the skill has no instruction body",
      remediation: "add the procedure to instructions.md",
    });
  }

  if (skill.capabilities.length === 0) {
    findings.push({
      kind: "manifest",
      severity: "warn",
      rule: "no-capabilities",
      message: "no capabilities declared — retrieval cannot key on this skill",
      remediation: "declare capability tags (e.g. planning, tdd, code-review)",
    });
  }

  if (skill.version === "0.0.0" || skill.version.trim().length === 0) {
    findings.push({
      kind: "manifest",
      severity: "warn",
      rule: "unversioned",
      message: `version "${skill.version}" looks unset`,
      remediation:
        "set a real version so drift and revalidation can be tracked",
    });
  }

  return findings;
}

/**
 * Extract the skill's effective capabilities: the manifest `capabilities` plus
 * any declared in a leading frontmatter block in the instruction body (skill
 * packs often carry `capabilities:` there). De-duplicated, manifest order first.
 */
export function extractCapabilities(skill: Skill): string[] {
  const out = [...skill.capabilities];
  const { fields } = parseFrontmatter(skill.instructions);
  const raw = fields.capabilities;
  if (raw) {
    for (const cap of raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0)) {
      if (!out.includes(cap)) out.push(cap);
    }
  }
  return out;
}

/**
 * License/provenance check. For an imported skill (has `provenance`): the
 * upstream ref must be pinned and a license declared, and when an explicit
 * `--source` is given it must match the recorded source. For a repo-authored
 * skill (no provenance) there is nothing external to check — but asserting a
 * `--source` against it is an error, since it was never imported.
 */
export function checkProvenance(
  skill: Skill,
  source?: string
): SkillCheckFinding[] {
  const findings: SkillCheckFinding[] = [];
  const p = skill.provenance;

  if (!p) {
    if (source !== undefined) {
      findings.push({
        kind: "provenance",
        severity: "error",
        rule: "not-imported",
        message: `--source "${source}" was given but "${skill.name}" is repo-authored (no provenance)`,
        remediation: "drop --source, or import the skill via otto-skills sync",
      });
    }
    return findings;
  }

  if (source !== undefined && p.source !== source) {
    findings.push({
      kind: "provenance",
      severity: "error",
      rule: "source-mismatch",
      message: `--source "${source}" does not match recorded source "${p.source}"`,
      remediation: `validate with --source ${p.source}, or re-import from ${source}`,
    });
  }

  if (!p.upstreamRef) {
    findings.push({
      kind: "provenance",
      severity: "warn",
      rule: "unpinned-ref",
      message: `imported "${skill.name}" has no pinned upstream ref`,
      remediation:
        "pin the source: otto-skills sources add <name> <url> --ref <sha-or-tag>",
    });
  }

  if (!p.license) {
    findings.push({
      kind: "provenance",
      severity: "warn",
      rule: "missing-license",
      message: `imported "${skill.name}" declares no license`,
      remediation: "add a license: field to the upstream SKILL.md and re-sync",
    });
  }

  return findings;
}

/**
 * One instruction-risk pattern. `re` matches a risky phrase in the skill body;
 * the first match's text becomes the finding's evidence. Patterns are
 * conservative — they target the unambiguous shapes (destructive commands,
 * pipe-to-shell, secret echoing, overrule attempts) so a normal procedure does
 * not trip them.
 */
type RiskPattern = {
  rule: string;
  severity: SkillCheckSeverity;
  re: RegExp;
  message: (hit: string) => string;
  remediation: string;
};

const RISK_PATTERNS: RiskPattern[] = [
  // Unsafe shell advice — destructive or self-elevating commands.
  {
    rule: "unsafe-shell",
    severity: "error",
    re: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*(?:\/|~|\$\w|\*)/i,
    message: (h) => `destructive delete in shell advice: "${h.trim()}"`,
    remediation: "scope deletes to a named path; never rm -rf / ~ or $VAR",
  },
  {
    rule: "unsafe-shell",
    severity: "error",
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|)sh\b/i,
    message: (h) => `pipes a download straight into a shell: "${h.trim()}"`,
    remediation:
      "download, inspect, then run — never pipe a fetch into a shell",
  },
  {
    rule: "unsafe-shell",
    severity: "error",
    re: /\bsudo\s+\S+/i,
    message: (h) => `requires elevated privileges: "${h.trim()}"`,
    remediation:
      "AFK runs unprivileged; remove sudo and operate in the workspace",
  },
  {
    rule: "unsafe-shell",
    severity: "error",
    re: /\bchmod\s+(?:-[a-z]+\s+)*777\b/i,
    message: (h) => `world-writable permissions: "${h.trim()}"`,
    remediation: "grant least-privilege permissions instead of 777",
  },
  // Secret handling — printing/echoing/logging credentials.
  {
    rule: "secret-handling",
    severity: "error",
    re: /\b(?:echo|print|printf|cat|log|paste|export)\b[^\n]{0,40}\b(?:[A-Z0-9_]*(?:SECRET|PASSWORD|API[_-]?KEY|TOKEN|CREDENTIAL)[A-Z0-9_]*)\b/i,
    message: (h) => `exposes a secret: "${h.trim()}"`,
    remediation: "never echo/log secrets; read them from the environment only",
  },
  // Network use — fetch commands that AFK policy may forbid.
  {
    rule: "network-use",
    severity: "warn",
    re: /\b(?:curl|wget|nc|netcat|ssh|scp|telnet)\s+\S+/i,
    message: (h) => `performs network I/O: "${h.trim()}"`,
    remediation:
      "AFK network is policy-scoped; declare needed domains in .otto/policy.json or avoid the call",
  },
  // Interactive hard stops — block AFK, mark the skill interactive-only.
  {
    rule: "interactive-hard-stop",
    severity: "warn",
    re: /\b(?:ask|prompt|wait for|confirm with|check with|get approval from)\b[^\n]{0,20}\b(?:the\s+)?(?:user|human|operator|reviewer)\b|\bdo not proceed until\b|\bSTOP and (?:ask|wait)\b|\bwait for (?:confirmation|approval|input)\b/i,
    message: (h) => `requires human interaction: "${h.trim()}"`,
    remediation:
      "provide an autonomous default for AFK, or classify the skill interactive-only",
  },
  // Unsupported tool assumptions — GUI/IDE/browser the AFK runtime lacks.
  {
    rule: "unsupported-tool",
    severity: "warn",
    re: /\b(?:open your browser|in your IDE|open .{0,20}in (?:vs ?code|the editor)|click (?:the|on)|drag and drop|take a screenshot)\b/i,
    message: (h) =>
      `assumes an interactive tool the AFK runtime lacks: "${h.trim()}"`,
    remediation: "replace GUI/IDE steps with CLI/file operations",
  },
  // Conflicting hierarchy — attempts to overrule repo policy / prior context.
  {
    rule: "conflicting-hierarchy",
    severity: "error",
    re: /\b(?:ignore|disregard|override|bypass|forget)\b[^\n]{0,30}\b(?:previous|prior|above|all)?\s*(?:instructions?|system prompt|repo policy|safety|policy|agents\.md|rules?)\b/i,
    message: (h) =>
      `tries to overrule the instruction hierarchy: "${h.trim()}"`,
    remediation:
      "skills are advisory; remove overrule language — repo policy and stage contracts win",
  },
];

/**
 * Scan a skill's instruction body for the six P17 risk categories (issue #133):
 * unsafe shell advice, secret handling, network use, interactive hard stops,
 * unsupported tool assumptions, and conflicting hierarchy (a skill trying to
 * overrule repo policy). Each finding names the exact matched phrase and a
 * remediation. Pure, deterministic, conservative — benign guidance yields `[]`.
 */
export function scanInstructionRisks(
  instructions: string
): SkillCheckFinding[] {
  const findings: SkillCheckFinding[] = [];
  for (const p of RISK_PATTERNS) {
    const m = p.re.exec(instructions);
    if (m) {
      findings.push({
        kind: "risk",
        severity: p.severity,
        rule: p.rule,
        message: p.message(m[0]),
        remediation: p.remediation,
      });
    }
  }
  return findings;
}

/**
 * A small behavior drill (issue #135): a declarative expectation about how a
 * skill of a given kind must classify. Drills are the cheap, deterministic half
 * of "static rules + small behavioral drills" — they assert that an imported
 * methodology lands in a usable, non-contradictory class for its intended stage,
 * without paying for a model run. `appliesTo` (any-match against the skill's
 * capabilities) decides whether a drill is in scope for a skill.
 */
export type SkillDrill = {
  name: string;
  description: string;
  /** Capabilities that bring this drill into scope (any-match). */
  appliesTo: string[];
  /** Compatibility classes this drill accepts. */
  expectClassIn: SkillCompatibility[];
  /** Finding rules that must NOT be present for the drill to pass. */
  forbidRules: string[];
};

/** One drill's outcome against a report. */
export type DrillResult = {
  drill: string;
  /** Whether the drill was in scope for this skill. */
  applied: boolean;
  /** True when not applied, or applied and satisfied. */
  passed: boolean;
  detail: string;
};

/**
 * The standard drills from the roadmap (issue #135): a Superpowers planning/TDD
 * drill (the methodology must be usable, not interactive-only/blocked), a PM
 * roadmap/PRD drill (must scope to the plan stage), and a review drill (a review
 * skill must not try to overrule repo policy).
 */
export const STANDARD_DRILLS: SkillDrill[] = [
  {
    name: "planning-tdd-usable",
    description:
      "a planning/TDD skill must be applicable, not interactive-only or blocked",
    appliesTo: ["planning", "tdd"],
    expectClassIn: ["afk-safe", "stage-scoped"],
    forbidRules: [],
  },
  {
    name: "pm-roadmap-prd-stage-scoped",
    description:
      "a PM roadmap/PRD skill must scope to a stage (plan), not be blocked",
    appliesTo: ["roadmap-planning", "prd"],
    expectClassIn: ["stage-scoped", "afk-safe"],
    forbidRules: [],
  },
  {
    name: "review-respects-policy",
    description: "a review skill must not try to overrule repo policy",
    appliesTo: ["code-review", "review"],
    expectClassIn: ["stage-scoped", "afk-safe"],
    forbidRules: ["conflicting-hierarchy"],
  },
];

/**
 * Run behavior drills against a validation report (issue #135). A drill applies
 * when the skill declares one of its `appliesTo` capabilities; an applied drill
 * passes when the report's class is in `expectClassIn` and none of its
 * `forbidRules` fired. A non-applicable drill is reported `applied: false,
 * passed: true` so it never blocks an unrelated skill. Pure, deterministic.
 */
export function runDrills(
  report: SkillValidationReport,
  drills: SkillDrill[] = STANDARD_DRILLS
): DrillResult[] {
  const caps = new Set(report.capabilities.map((c) => c.toLowerCase()));
  return drills.map((drill) => {
    const applied = drill.appliesTo.some((c) => caps.has(c.toLowerCase()));
    if (!applied) {
      return {
        drill: drill.name,
        applied: false,
        passed: true,
        detail: "not in scope",
      };
    }
    const classOk = drill.expectClassIn.includes(report.compatibility);
    const firedForbidden = drill.forbidRules.filter((r) =>
      report.findings.some((f) => f.rule === r)
    );
    const passed = classOk && firedForbidden.length === 0;
    const detail = passed
      ? `class ${report.compatibility} accepted`
      : !classOk
        ? `class ${report.compatibility} not in {${drill.expectClassIn.join(", ")}}`
        : `forbidden finding(s): ${firedForbidden.join(", ")}`;
    return { drill: drill.name, applied: true, passed, detail };
  });
}

/**
 * Whether a statically-validated skill must be revalidated before reuse (issue
 * #135). True when the skill carries a recorded `instructionsChecksum` (it was
 * validated) but its current body no longer hashes to it — the skill drifted
 * (e.g. an upstream re-sync changed it) since the gate last ran. A skill that was
 * never statically validated has nothing to revalidate, so this is false. Pure.
 */
export function needsRevalidation(skill: Skill): boolean {
  const recorded = skill.validation.instructionsChecksum;
  if (!recorded) return false;
  return skillChecksum(skill.instructions) !== recorded;
}

/**
 * Run the full static gate over one skill and aggregate the result: manifest
 * lint, capability extraction, provenance check (#132), instruction-risk scan
 * (#133), derived compatibility class (#134), and behavior drills (#135). `ok` is
 * false when any `error`-severity finding fired OR an applicable drill failed.
 * Pure — the caller decides whether to persist or print the report.
 */
export function validateSkill(
  skill: Skill,
  opts: { source?: string } = {}
): SkillValidationReport {
  const findings = [
    ...lintManifest(skill),
    ...checkProvenance(skill, opts.source),
    ...scanInstructionRisks(skill.instructions),
  ];
  const base: SkillValidationReport = {
    skill: skill.name,
    capabilities: extractCapabilities(skill),
    findings,
    ok: !findings.some((f) => f.severity === "error"),
    compatibility: "afk-safe",
    stages: [],
    checksum: skillChecksum(skill.instructions),
    drills: [],
  };
  const { compatibility, stages } = classifyCompatibility(base);
  const drills = runDrills({ ...base, compatibility, stages });
  const ok = base.ok && drills.every((d) => d.passed);
  return { ...base, compatibility, stages, drills, ok };
}
