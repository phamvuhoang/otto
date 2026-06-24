/**
 * Model-tier routing substrate (issue #66 P11). Pure: a stage's difficulty
 * `ModelTier` resolves to a concrete model spec via a config-overridable ladder,
 * and `routeModel` modulates the tier by change-risk + failure escalation. No
 * I/O, no model calls — so routing is reproducible and the eval suite can A/B it.
 */

import type { AgentRuntimeId } from "./agent-runtime.js";
import type { RiskAssessment } from "./risk.js";
import type { Stage } from "./stages.js";

/** Stage difficulty, low → high cost. */
export type ModelTier = "cheap" | "mid" | "strong";

/** tier → concrete model spec passed to the runtime's `--model` (undefined = runtime default). */
export type TierLadder = Record<ModelTier, string | undefined>;

/** Claude CLI aliases; overridable per tier via OTTO_TIER_*. */
export const DEFAULT_LADDER: TierLadder = {
  cheap: "haiku",
  mid: "sonnet",
  strong: "opus",
};

const ENV_OF: Record<ModelTier, string> = {
  cheap: "OTTO_TIER_CHEAP",
  mid: "OTTO_TIER_MID",
  strong: "OTTO_TIER_STRONG",
};

/** Overlay OTTO_TIER_CHEAP/MID/STRONG onto {@link DEFAULT_LADDER}; blank ⇒ default. */
export function resolveTierLadder(
  env: NodeJS.ProcessEnv = process.env
): TierLadder {
  const ladder: TierLadder = { ...DEFAULT_LADDER };
  for (const tier of ["cheap", "mid", "strong"] as const) {
    const v = env[ENV_OF[tier]]?.trim();
    if (v) ladder[tier] = v;
  }
  return ladder;
}

/**
 * Resolve the model spec for the active runtime (issue #24 P3). A
 * provider-specific override (`OTTO_CLAUDE_MODEL` / `OTTO_CODEX_MODEL`) wins
 * over the provider-neutral `OTTO_MODEL`, so a user who keeps both runtimes
 * configured can pin a model per runtime. Returns the resolved spec plus the
 * env var it came from (for `--print-config`), or `undefined` when nothing is
 * set (the runtime's CLI default applies). Empty/whitespace overrides are
 * ignored so they fall through to the generic value.
 *
 * Lives here (not in runner.ts) so the pin check stays decoupled from the
 * heavily-mocked runner module (issue #66 P11).
 */
export function resolveModelSelection(
  runtimeId: AgentRuntimeId,
  env: NodeJS.ProcessEnv = process.env
): { spec: string; source: string } | undefined {
  const specificVar = `OTTO_${runtimeId.toUpperCase()}_MODEL`;
  const specific = env[specificVar]?.trim();
  if (specific) return { spec: specific, source: specificVar };
  const generic = env.OTTO_MODEL?.trim();
  if (generic) return { spec: generic, source: "OTTO_MODEL" };
  return undefined;
}

/** Tier ordering, low → high; bumps clamp to this range. */
const ORDER: ModelTier[] = ["cheap", "mid", "strong"];

function bump(tier: ModelTier, by: number): ModelTier {
  const i = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(tier) + by));
  return ORDER[i];
}

/**
 * Modulate a base tier by change-risk and failure escalation (issue #66 P11).
 * Pure. Rules: docs-only / test-only → one tier cheaper (floor cheap);
 * security-sensitive / cross-module → strong; each prior escalation → one tier
 * stronger. All bumps clamp to [cheap, strong].
 */
export function routeModel(opts: {
  baseTier: ModelTier;
  assessment?: RiskAssessment;
  escalations?: number;
}): { tier: ModelTier; reasons: string[] } {
  const reasons: string[] = [`base tier ${opts.baseTier}`];
  let tier = opts.baseTier;
  const cls = opts.assessment?.class;
  if (cls === "docs-only" || cls === "test-only") {
    tier = bump(tier, -1);
    reasons.push(`risk-down (${cls}) → ${tier}`);
  } else if (cls === "security-sensitive" || cls === "cross-module") {
    tier = "strong";
    reasons.push(`risk-up (${cls}) → strong`);
  }
  const esc = opts.escalations ?? 0;
  if (esc > 0) {
    tier = bump(tier, esc);
    reasons.push(`escalated ×${esc} → ${tier}`);
  }
  return { tier, reasons };
}

/** Base model tier per review lens (P14). Structural/security reasoning gets the
 *  strong tier; mechanical lenses run cheaper. Pin (OTTO_MODEL/OTTO_CLAUDE_MODEL)
 *  and failure-escalation still take precedence in resolveStageModel/routeModel. */
export const LENS_TIER: Record<string, ModelTier> = {
  structural: "strong",
  security: "strong",
  correctness: "mid",
  "task-fit": "mid",
  tests: "cheap",
};

export function tierForLens(lens: string): ModelTier {
  return LENS_TIER[lens] ?? "mid";
}

/** The model decision for one stage: the spec, the tier (when routed), and why. */
export type StageModel = {
  spec: string | undefined;
  tier?: ModelTier;
  source: "pin" | "route" | "default";
};

/**
 * Resolve the model spec for one stage. Precedence (back-compat invariant):
 * an explicit pin (OTTO_${RUNTIME}_MODEL / OTTO_MODEL) wins and disables
 * routing; else routing on + a declared tier ⇒ ladder[routeModel(...)]; else
 * the runtime default (undefined).
 */
export function resolveStageModel(opts: {
  runtimeId: AgentRuntimeId;
  stage: Stage;
  routing: boolean;
  ladder: TierLadder;
  assessment?: RiskAssessment;
  escalations?: number;
  env?: NodeJS.ProcessEnv;
}): StageModel {
  const pin = resolveModelSelection(opts.runtimeId, opts.env ?? process.env);
  if (pin) return { spec: pin.spec, source: "pin" };
  if (!opts.routing || !opts.stage.tier) {
    return { spec: undefined, source: "default" };
  }
  const { tier } = routeModel({
    baseTier: opts.stage.tier,
    assessment: opts.assessment,
    escalations: opts.escalations,
  });
  return { spec: opts.ladder[tier], tier, source: "route" };
}
