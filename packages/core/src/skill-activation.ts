import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime skill activation (issue #114 P18). Whether validated skills may shape
 * live stages is **opt-in and off by default** — a run that does not opt in is
 * byte-for-byte unchanged (no retrieval, no injection, no evidence). Activation
 * resolves from three sources in precedence order, mirroring `resolveAgentRuntime`
 * and the journal double-opt-in: `--use-skills` flag → `OTTO_USE_SKILLS` env →
 * `.otto/config.json` `skills` block → default off.
 *
 * Per-stage-family overrides (`skills.plan`, `skills.implement`, `skills.review`,
 * `skills.report`, `skills.journal`) gate individual families; a family with no
 * override follows the global switch. This module is pure config logic — routing
 * and injection live in `skill-routing.ts`, the loop does the wiring.
 */

/** The stage families a skill can be scoped to / activated for. */
export type StageFamily =
  | "plan"
  | "implement"
  | "review"
  | "report"
  | "journal";

const STAGE_FAMILIES: readonly StageFamily[] = [
  "plan",
  "implement",
  "review",
  "report",
  "journal",
];

/** Resolved activation: the master switch + per-family overrides. */
export type SkillActivation = {
  /** Master switch — when false, no skill is ever selected or injected. */
  enabled: boolean;
  /** Per-family overrides; absent key = follow {@link enabled}. */
  stages: Partial<Record<StageFamily, boolean>>;
};

const TRUTHY: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/**
 * Read `.otto/config.json`'s `skills` block as a raw record (the parser in
 * {@link resolveSkillActivation} normalizes it). Absent/malformed file or block →
 * undefined (zero behavior change). Mirrors `readJournalConfig`/`readAgentConfig`.
 */
export function readSkillsConfig(workspaceDir: string): unknown {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    return raw.skills;
  } catch {
    return undefined;
  }
}

/**
 * Resolve activation from flag/env/config. `--use-skills` (flag) or a truthy
 * `OTTO_USE_SKILLS` (env) force-enable regardless of config; otherwise
 * `config.skills.enabled === true` enables. Per-family booleans on the config
 * block are carried through as overrides. Pure — the caller supplies the raw
 * inputs (mirrors `resolveAgentRuntime`).
 */
export function resolveSkillActivation(opts: {
  flag?: boolean;
  env?: string;
  config?: unknown;
}): SkillActivation {
  const cfg =
    opts.config !== null &&
    typeof opts.config === "object" &&
    !Array.isArray(opts.config)
      ? (opts.config as Record<string, unknown>)
      : {};
  const envOn = TRUTHY.has((opts.env ?? "").trim().toLowerCase());
  const enabled = opts.flag === true || envOn || cfg.enabled === true;

  const stages: Partial<Record<StageFamily, boolean>> = {};
  for (const family of STAGE_FAMILIES) {
    if (typeof cfg[family] === "boolean")
      stages[family] = cfg[family] as boolean;
  }
  return { enabled, stages };
}

/**
 * Whether skills are active for a given stage family: the master switch must be
 * on AND the family's override (if any) must not be false. A family with no
 * override follows the master switch. Pure.
 */
export function stageEnabled(
  activation: SkillActivation,
  family: StageFamily
): boolean {
  if (!activation.enabled) return false;
  return activation.stages[family] !== false;
}
