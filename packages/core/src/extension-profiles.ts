import type { ExternalSkillSource } from "./external-skills.js";
import { headroomToolDefinition } from "./headroom-adapter.js";
import type { SafetyPolicy } from "./safety-policy.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Curated extension profiles (issue #115 P21). A **profile** bundles the P16–P20
 * primitives — skill sources, tool adapters, activation config, and safety policy
 * — into one opinionated, lockable starting point for a common job. `otto-extensions
 * init <profile>` (see `extensions-cli.ts`) materializes a profile as **normal,
 * inspectable config**: `.otto/skills/sources.json`, `.otto/tools/<name>.json`,
 * `.otto/config.json`, and `.otto/policy.json`. Nothing here is hidden behavior —
 * a profile only writes the same files a user could write by hand, so the
 * governance model (pinned sources, validated skills, policy-scoped tools) stays
 * fully in force and every choice is diffable.
 *
 * Profiles do NOT auto-trust their sources: a registered source is still imported
 * `unverified` and must clear the P17 validation gate before P18 will inject it.
 */

/** A declarative profile manifest — pure data, no I/O. */
export type ExtensionProfile = {
  /** Profile id, also the `init <name>` argument. */
  name: string;
  description: string;
  /** Skill sources to register (git/archive sources are pinned). */
  sources: ExternalSkillSource[];
  /** Tool adapters to write under `.otto/tools/`. */
  tools: ToolDefinition[];
  /** Config entries merged into `.otto/config.json`. */
  config: Record<string, unknown>;
  /** Safety-policy additions merged (union) into `.otto/policy.json`. */
  policy?: Partial<SafetyPolicy>;
  /** Local binaries/services the profile needs — surfaced in the compat matrix. */
  requires: string[];
  /** One-line note shown after `init` (e.g. the validate/sync follow-up). */
  followUp: string;
};

/**
 * Pinned upstream refs for the external sources. Tags, never branches, so a
 * profile never registers a "broad unpinned ref" (a P21 success metric). Kept in
 * one place so the compatibility matrix and the manifests cannot drift.
 */
const SUPERPOWERS_REF = "v6.0.3";
const PM_SKILLS_REF = "v1.0.0";

const PROFILES: ExtensionProfile[] = [
  {
    name: "coding-superpowers",
    description:
      "Superpowers coding methodology (AFK-safe subset) for implement + review stages.",
    sources: [
      {
        name: "superpowers",
        type: "git",
        location: "https://github.com/obra/superpowers",
        ref: SUPERPOWERS_REF,
      },
    ],
    tools: [],
    // Activate skills only where coding methodology helps; plan/report stay off
    // so an imported PM skill (a different profile) never bleeds into coding runs.
    config: { skills: { enabled: true, implement: true, review: true } },
    requires: ["git"],
    followUp:
      "Next: otto-skills sync && otto-skills validate <skill> — only validated, afk-safe skills are injected.",
  },
  {
    name: "pm-planning",
    description:
      "PM frameworks (roadmap, prioritization, PRD, problem-framing) for plan + report stages.",
    sources: [
      {
        name: "pm-skills",
        type: "git",
        location: "https://github.com/deanpeters/Product-Manager-Skills",
        ref: PM_SKILLS_REF,
      },
    ],
    tools: [],
    config: { skills: { enabled: true, plan: true, report: true } },
    requires: ["git"],
    followUp:
      "Next: otto-skills sync && otto-skills validate <skill>; pairs with otto-afk --plan.",
  },
  {
    name: "context-saver",
    description:
      "Local-first Headroom context compression + context-report defaults to cut tokens.",
    sources: [],
    tools: [headroomToolDefinition()],
    config: { contextCompressor: "headroom" },
    requires: ["python3", "headroom-ai"],
    followUp:
      "Next: pip install headroom-ai (the local Python library — no API key), then otto-tools health to confirm it resolves.",
  },
  {
    name: "security-review",
    description:
      "Security/structural review posture: skills on the review stage + a stricter safety policy.",
    sources: [],
    tools: [],
    config: { skills: { enabled: true, review: true } },
    // Stricter governance: deny obviously dangerous shell, flag secret-shaped
    // strings, and gate force-push/history-rewrite behind approval. Merged (union)
    // into any existing .otto/policy.json — never relaxes an existing rule.
    policy: {
      blockedCommands: ["rm -rf /", "curl | sh", "curl | bash"],
      secretPatterns: [
        "AKIA[0-9A-Z]{16}",
        "-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----",
      ],
      approvalRequiredActions: ["git push --force", "git reset --hard"],
    },
    requires: [],
    followUp:
      "Next: pair with otto-afk --review-panel; review .otto/policy.json and tighten further as needed.",
  },
];

/** All curated profiles, sorted by name. Pure. */
export function listProfiles(): ExtensionProfile[] {
  return [...PROFILES].sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up one profile by name, or null when unknown. Pure. */
export function getProfile(name: string): ExtensionProfile | null {
  return PROFILES.find((p) => p.name === name) ?? null;
}

/** Map of profile name → manifest, for callers that prefer keyed access. */
export const EXTENSION_PROFILES: Readonly<Record<string, ExtensionProfile>> =
  Object.freeze(Object.fromEntries(PROFILES.map((p) => [p.name, p])));
