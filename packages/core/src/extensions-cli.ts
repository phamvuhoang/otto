import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  getProfile,
  listProfiles,
  type ExtensionProfile,
} from "./extension-profiles.js";
import { addSource, readSources, writeSources } from "./external-skills.js";
import {
  DEFAULT_POLICY,
  readSafetyPolicy,
  type SafetyPolicy,
} from "./safety-policy.js";
import { toolPath, toolsDir, type ToolDefinition } from "./tools.js";

/**
 * `otto-extensions` — materialize a curated {@link ExtensionProfile} (issue #115
 * P21) into normal, inspectable repo config. `init <profile>` writes the same
 * files a user could write by hand — `.otto/skills/sources.json`,
 * `.otto/tools/<name>.json`, `.otto/config.json`, `.otto/policy.json` — so the
 * P16–P20 governance model stays in force and every choice is diffable. There is
 * no hidden runtime behavior: a profile registers pinned sources (still imported
 * `unverified`), tool adapters (still policy-scoped), and activation config (still
 * off until the user opts in). Read-only `list`; `init` is the only writer, and
 * `--dry-run` makes even that a preview.
 */

export type ExtensionsDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: ExtensionsDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const CONFIG_REL = join(".otto", "config.json");
const POLICY_REL = join(".otto", "policy.json");

/** One change a profile would make. */
export type ProfilePlanItem = {
  kind: "source" | "tool" | "config" | "policy";
  target: string;
  detail: string;
};

export type ProfilePlan = {
  profile: string;
  items: ProfilePlanItem[];
  followUp: string;
  requires: string[];
};

/** Compute what applying `profile` to `workspaceDir` would write. Pure preview. */
export function planProfile(
  workspaceDir: string,
  profile: ExtensionProfile
): ProfilePlan {
  const items: ProfilePlanItem[] = [];
  for (const s of profile.sources) {
    items.push({
      kind: "source",
      target: s.name,
      detail: `${s.type} ${s.location}${s.ref ? ` @${s.ref}` : ""}`,
    });
  }
  for (const t of profile.tools) {
    items.push({
      kind: "tool",
      target: t.name,
      detail: `${t.kind}${t.command ? ` (${t.command})` : ""}`,
    });
  }
  for (const [k, v] of Object.entries(profile.config)) {
    items.push({ kind: "config", target: k, detail: JSON.stringify(v) });
  }
  if (profile.policy) {
    for (const [k, v] of Object.entries(profile.policy)) {
      if (Array.isArray(v) && v.length > 0) {
        items.push({
          kind: "policy",
          target: k,
          detail: `+${v.length} rule(s)`,
        });
      }
    }
  }
  return {
    profile: profile.name,
    items,
    followUp: profile.followUp,
    requires: profile.requires,
  };
}

/** Read `.otto/config.json` as a record; absent/malformed → `{}`. */
function readConfig(workspaceDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, CONFIG_REL), "utf8")
    ) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge `additions` into `base` one level deep: a plain-object value is merged
 * with an existing plain-object value (so `skills.plan` and `skills.review` from
 * two profiles coexist); any other value overwrites. Never mutates the inputs.
 */
function mergeConfig(
  base: Record<string, unknown>,
  additions: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(additions)) {
    const existing = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[k] = {
        ...(existing as Record<string, unknown>),
        ...(v as Record<string, unknown>),
      };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function writeConfig(
  workspaceDir: string,
  config: Record<string, unknown>
): void {
  mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
  writeFileSync(
    join(workspaceDir, CONFIG_REL),
    JSON.stringify(config, null, 2) + "\n"
  );
}

/** Union the profile's policy lists into the existing policy (never relaxes). */
function mergePolicy(
  workspaceDir: string,
  additions: Partial<SafetyPolicy>
): void {
  const current = readSafetyPolicy(workspaceDir);
  const merged: SafetyPolicy = { ...current };
  for (const key of Object.keys(DEFAULT_POLICY) as (keyof SafetyPolicy)[]) {
    const add = additions[key];
    if (Array.isArray(add) && add.length > 0) {
      merged[key] = [...new Set([...current[key], ...add])];
    }
  }
  mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
  writeFileSync(
    join(workspaceDir, POLICY_REL),
    JSON.stringify(merged, null, 2) + "\n"
  );
}

function writeToolDefinition(workspaceDir: string, tool: ToolDefinition): void {
  mkdirSync(toolsDir(workspaceDir), { recursive: true });
  writeFileSync(
    toolPath(workspaceDir, tool.name),
    JSON.stringify(tool, null, 2) + "\n"
  );
}

/**
 * Apply a profile: register its sources (idempotent — `addSource` replaces by
 * name), write its tool definitions, merge its config and policy. Returns the
 * same plan {@link planProfile} would, after writing. Idempotent: re-applying a
 * profile converges to the same files rather than duplicating entries.
 */
export function applyProfile(
  workspaceDir: string,
  profile: ExtensionProfile
): ProfilePlan {
  if (profile.sources.length > 0) {
    mkdirSync(join(workspaceDir, ".otto", "skills"), { recursive: true });
    let sources = readSources(workspaceDir);
    for (const s of profile.sources) sources = addSource(sources, s);
    writeSources(workspaceDir, sources);
  }
  for (const t of profile.tools) writeToolDefinition(workspaceDir, t);
  if (Object.keys(profile.config).length > 0) {
    writeConfig(
      workspaceDir,
      mergeConfig(readConfig(workspaceDir), profile.config)
    );
  }
  if (profile.policy) mergePolicy(workspaceDir, profile.policy);
  return planProfile(workspaceDir, profile);
}

const USAGE =
  "Usage: otto-extensions list\n" +
  "       otto-extensions init <profile> [--dry-run]";

/** Render the available profiles, one block each. Pure. */
export function formatProfileList(profiles: ExtensionProfile[]): string {
  const lines: string[] = ["Curated extension profiles:"];
  for (const p of profiles) {
    lines.push(`- ${p.name}`);
    lines.push(`    ${p.description}`);
    const bits = [
      p.sources.length ? `${p.sources.length} source(s)` : "",
      p.tools.length ? `${p.tools.length} tool(s)` : "",
      Object.keys(p.config).length ? "config" : "",
      p.policy ? "policy" : "",
    ].filter(Boolean);
    lines.push(`    writes: ${bits.join(", ") || "(nothing)"}`);
    if (p.requires.length) lines.push(`    requires: ${p.requires.join(", ")}`);
  }
  lines.push("");
  lines.push("Enable one: otto-extensions init <profile> [--dry-run]");
  return lines.join("\n");
}

/** Render a profile plan; `dryRun` flips the header between preview and applied. */
export function formatProfilePlan(plan: ProfilePlan, dryRun: boolean): string {
  const lines: string[] = [
    dryRun
      ? `Plan for '${plan.profile}' (--dry-run, nothing written):`
      : `Applied '${plan.profile}':`,
  ];
  if (plan.items.length === 0) {
    lines.push("  (nothing to write)");
  }
  for (const i of plan.items) {
    lines.push(`  ${i.kind.padEnd(7)} ${i.target}  ${i.detail}`);
  }
  if (plan.requires.length > 0) {
    lines.push("");
    lines.push(`Requires: ${plan.requires.join(", ")}`);
  }
  lines.push("");
  lines.push(plan.followUp);
  return lines.join("\n");
}

/**
 * Drive `otto-extensions`: `list` (default) shows the curated profiles; `init
 * <profile> [--dry-run]` previews or writes the profile's config. Resolves to the
 * process exit code (mirrors `runSkills`/`runTools`).
 */
export async function runExtensions(
  argv: string[],
  deps: ExtensionsDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }
  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);

  if (arg === undefined || arg === "list") {
    deps.out(formatProfileList(listProfiles()));
    return 0;
  }

  if (arg === "init") {
    const name = argv.slice(1).find((a) => !a.startsWith("--"));
    if (!name) {
      deps.err(`init needs a <profile> name.\n${USAGE}`);
      return 1;
    }
    const profile = getProfile(name);
    if (!profile) {
      const known = listProfiles()
        .map((p) => p.name)
        .join(", ");
      deps.err(`Unknown profile '${name}'. Available: ${known}`);
      return 1;
    }
    const dryRun = argv.includes("--dry-run");
    const plan = dryRun
      ? planProfile(workspaceDir, profile)
      : applyProfile(workspaceDir, profile);
    deps.out(formatProfilePlan(plan, dryRun));
    return 0;
  }

  deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
  return 1;
}
