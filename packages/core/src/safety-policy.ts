import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo-local safety rules, loaded from `.otto/policy.json` (issue #43 P4).
 * Governs what an unattended run may do with untrusted inputs and risky tool
 * use. Every field is a list of strings; an EMPTY list means "no restriction"
 * for that axis, so the {@link DEFAULT_POLICY} (all empty) leaves today's
 * trusted local plan/PRD workflows unchanged — a repo opts INTO governance by
 * populating the file.
 *
 * The three slices that follow build on this substrate: pure evaluation
 * predicates over a policy, taint tracking of untrusted sources, and finally the
 * boundary checks around shell/`@spill` tags and stage execution. This module is
 * INERT (exported from `index.ts`, imported by no bin/loop) so loading a policy
 * cannot regress a run.
 */
export type SafetyPolicy = {
  /** Workspace-relative roots Otto may write under; empty = unrestricted. */
  allowedWriteRoots: string[];
  /** Command substrings/patterns a run must not execute; empty = none blocked. */
  blockedCommands: string[];
  /** Network domains a run may reach; empty = unrestricted. */
  allowedNetworkDomains: string[];
  /** Patterns identifying secrets that must not be emitted; empty = none. */
  secretPatterns: string[];
  /** Globs marking high-risk files that warrant extra scrutiny; empty = none. */
  highRiskGlobs: string[];
  /** Action names that require human approval before they run; empty = none. */
  approvalRequiredActions: string[];
};

/** The six rule lists, in declaration order — the single source of field names. */
const RULE_FIELDS: readonly (keyof SafetyPolicy)[] = [
  "allowedWriteRoots",
  "blockedCommands",
  "allowedNetworkDomains",
  "secretPatterns",
  "highRiskGlobs",
  "approvalRequiredActions",
];

/**
 * The permissive default: every rule list empty, so a workspace with no
 * `.otto/policy.json` behaves exactly as it does today (success metric #3).
 */
export const DEFAULT_POLICY: SafetyPolicy = Object.freeze({
  allowedWriteRoots: [],
  blockedCommands: [],
  allowedNetworkDomains: [],
  secretPatterns: [],
  highRiskGlobs: [],
  approvalRequiredActions: [],
}) as SafetyPolicy;

/** Coerce one field of an untrusted parsed object into a string list. */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
}

/**
 * Normalize an untrusted parsed value into a {@link SafetyPolicy}, filling the
 * permissive default for every missing/invalid field. Never throws: a
 * non-object/array/null input → {@link DEFAULT_POLICY}; a non-array field → its
 * default `[]`; non-string array elements are filtered. Always returns a fresh
 * object with fresh arrays (never the shared frozen default reference).
 */
export function parseSafetyPolicy(raw: unknown): SafetyPolicy {
  const o =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const policy = {} as SafetyPolicy;
  for (const field of RULE_FIELDS) {
    policy[field] = stringList(o[field]);
  }
  return policy;
}

/** The axis of policy a {@link PolicyViolation} breached. */
export type PolicyViolationKind =
  | "blocked-command"
  | "write-root"
  | "network-domain"
  | "approval-required";

/**
 * A single breach found by an evaluation predicate. `subject` is the thing
 * checked (command/path/domain/action); `message` is a human-readable
 * explanation. Predicates return an EMPTY array under {@link DEFAULT_POLICY}.
 */
export type PolicyViolation = {
  kind: PolicyViolationKind;
  subject: string;
  message: string;
};

/**
 * Deny-list check: a violation per {@link SafetyPolicy.blockedCommands} substring
 * that appears in `command`. Empty list → no violations (DEFAULT_POLICY).
 */
export function checkCommand(
  policy: SafetyPolicy,
  command: string
): PolicyViolation[] {
  return policy.blockedCommands
    .filter((pattern) => command.includes(pattern))
    .map((pattern) => ({
      kind: "blocked-command",
      subject: command,
      message: `command matches blocked pattern "${pattern}"`,
    }));
}

/** Strip trailing slashes so `src/` and `src` name the same root. */
function trimRoot(root: string): string {
  return root.replace(/\/+$/, "");
}

/**
 * Allow-list check over workspace-relative {@link SafetyPolicy.allowedWriteRoots}:
 * empty → unrestricted (no violations). Otherwise a single violation when `path`
 * is neither equal to nor nested under any allowed root. A root of `.` (or empty
 * after trimming) permits the whole workspace.
 */
export function checkWritePath(
  policy: SafetyPolicy,
  path: string
): PolicyViolation[] {
  if (policy.allowedWriteRoots.length === 0) return [];
  const allowed = policy.allowedWriteRoots.some((raw) => {
    const root = trimRoot(raw);
    if (root === "" || root === ".") return true;
    return path === root || path.startsWith(root + "/");
  });
  return allowed
    ? []
    : [
        {
          kind: "write-root",
          subject: path,
          message: "path is outside every allowed write root",
        },
      ];
}

/**
 * Allow-list check over {@link SafetyPolicy.allowedNetworkDomains}: empty →
 * unrestricted. Otherwise a single violation when `domain` is neither an allowed
 * domain nor a subdomain of one (case-insensitive).
 */
export function checkNetworkDomain(
  policy: SafetyPolicy,
  domain: string
): PolicyViolation[] {
  if (policy.allowedNetworkDomains.length === 0) return [];
  const d = domain.toLowerCase();
  const allowed = policy.allowedNetworkDomains.some((raw) => {
    const a = raw.toLowerCase();
    return d === a || d.endsWith("." + a);
  });
  return allowed
    ? []
    : [
        {
          kind: "network-domain",
          subject: domain,
          message: "domain is not in the allowed network domains",
        },
      ];
}

/**
 * Flag check over {@link SafetyPolicy.approvalRequiredActions}: a violation when
 * `action` exactly matches a listed action. Empty list → no violations.
 */
export function checkApprovalRequired(
  policy: SafetyPolicy,
  action: string
): PolicyViolation[] {
  return policy.approvalRequiredActions.includes(action)
    ? [
        {
          kind: "approval-required",
          subject: action,
          message: `action "${action}" requires human approval`,
        },
      ]
    : [];
}

const POLICY_REL = join(".otto", "policy.json");

/**
 * Read and normalize `.otto/policy.json` from a workspace. Absent or malformed
 * file → {@link DEFAULT_POLICY} (never throws), so a missing/corrupt policy
 * fails open to today's unrestricted behavior rather than blocking a run.
 */
export function readSafetyPolicy(workspaceDir: string): SafetyPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(workspaceDir, POLICY_REL), "utf8"));
  } catch {
    return parseSafetyPolicy(undefined);
  }
  return parseSafetyPolicy(raw);
}
