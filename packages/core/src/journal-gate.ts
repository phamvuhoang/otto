/**
 * The P12 outbound secrecy gate (issue #67). Layered, default-deny: a journal
 * note is published only if it passes every gate. Gate 1 (here) is the pure,
 * deterministic deny-list — the backbone. Gates 2 (generalization) and 3
 * (adversarial judge) are added in later slices. ZERO-LEAK is the hard gate:
 * anything ambiguous is denied, and a thrown check denies rather than crashes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type GateContext = {
  /** This repo's own identifiers (name, owner, remote host, dir basename, top files). */
  repoIdentifiers: string[];
  /** Extra deny patterns from SafetyPolicy.secretPatterns (.otto/policy.json). */
  secretPatterns: string[];
  /** Terms carried from the source record (scope globs / taskKey / run id). */
  forbiddenTerms: string[];
};

export type GateResult =
  | { ok: true }
  | { ok: false; gate: 1 | 2 | 3; reason: string };

/** Built-in secret/identifier deny patterns. Each is intentionally broad — this
 *  gate is biased to over-deny. The pattern NAME is logged, never the match. */
const DENY: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { name: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{8,}/i },
  {
    name: "assignment-secret",
    re: /\b(password|passwd|secret|api[_-]?key|token|access[_-]?key)\b\s*[:=]\s*\S+/i,
  },
  { name: "url", re: /\bhttps?:\/\/\S+/i },
  { name: "abs-path", re: /(^|\s)(\/[\w.-]+){2,}/ },
  { name: "rel-path", re: /(^|\s)\.{1,2}\/[\w./-]+/ },
  { name: "win-path", re: /\b[A-Za-z]:\\[\\\w.-]+/ },
  { name: "code-fence", re: /```/ },
  { name: "code-span", re: /`[^`]+`/ },
  { name: "scoped-pkg", re: /(^|\s)@[a-z0-9-]+\/[a-z0-9-]+/i },
  { name: "import-stmt", re: /\b(import\s.+\sfrom\s|require\s*\()/ },
];

/** Build a word-ish, case-insensitive matcher for a repo identifier. */
function identifierRe(id: string): RegExp | null {
  const trimmed = id.trim();
  if (trimmed.length < 3) return null; // too short → too many false denials
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
}

/**
 * Gate 1: deny if the entry matches any built-in secret/identifier pattern, any
 * repo self-identifier, or any policy secretPattern. A malformed policy pattern
 * is treated as a denial (fail closed). Pure; never mutates inputs.
 */
export function screenGate1(entry: string, ctx: GateContext): GateResult {
  for (const { name, re } of DENY) {
    if (re.test(entry)) return { ok: false, gate: 1, reason: `deny:${name}` };
  }
  for (const id of ctx.repoIdentifiers) {
    const re = identifierRe(id);
    if (re && re.test(entry)) {
      return { ok: false, gate: 1, reason: "deny:repo-identifier" };
    }
  }
  for (const pattern of ctx.secretPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      // a malformed policy pattern fails closed — we cannot prove safety.
      return { ok: false, gate: 1, reason: "deny:malformed-policy-pattern" };
    }
    if (re.test(entry)) {
      return { ok: false, gate: 1, reason: "deny:policy-secret-pattern" };
    }
  }
  return { ok: true };
}

export const MAX_ENTRY_CHARS = 500;
export const MIN_ENTRY_CHARS = 20;

/** Shapes that betray a specific task/ticket. */
const TASK_KEY_RE = /\b(issue-\d+|[A-Z]{2,}-\d+)\b/;

/**
 * Gate 2: the note must read as GENERIC craft. Deny task-key shapes, any term
 * carried from the source record (scope globs / taskKey / run id), and notes
 * outside the length bounds. Pure.
 */
export function screenGate2(entry: string, ctx: GateContext): GateResult {
  const text = entry.trim();
  if (text.length < MIN_ENTRY_CHARS || text.length > MAX_ENTRY_CHARS) {
    return { ok: false, gate: 2, reason: "deny:length" };
  }
  if (TASK_KEY_RE.test(text)) {
    return { ok: false, gate: 2, reason: "deny:task-key" };
  }
  for (const term of ctx.forbiddenTerms) {
    const t = term.trim();
    if (
      t.length >= 3 &&
      new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)
    ) {
      return { ok: false, gate: 2, reason: "deny:forbidden-term" };
    }
  }
  return { ok: true };
}

export type Gate3Judge = (entry: string) => Promise<boolean>;

/**
 * Run the full gate: 1 (deny-list) → 2 (generalization) → 3 (judge, optional).
 * Default-deny: an empty entry, any non-pass gate, or a thrown judge denies. The
 * judge runs LAST and only on an entry the deterministic gates already passed.
 */
export async function screenEntry(
  entry: string,
  ctx: GateContext,
  judge?: Gate3Judge
): Promise<GateResult> {
  if (!entry || !entry.trim()) {
    return { ok: false, gate: 1, reason: "deny:empty" };
  }
  const g1 = screenGate1(entry, ctx);
  if (!g1.ok) return g1;
  const g2 = screenGate2(entry, ctx);
  if (!g2.ok) return g2;
  if (judge) {
    try {
      const safe = await judge(entry);
      if (!safe) return { ok: false, gate: 3, reason: "deny:judge-unsafe" };
    } catch {
      return { ok: false, gate: 3, reason: "deny:judge-error" };
    }
  }
  return { ok: true };
}

/** Append one JSON line to the journal audit trail. Never throws. */
export function appendAudit(
  workspaceDir: string,
  line: Record<string, unknown>
): void {
  try {
    const path = join(workspaceDir, ".otto", "journal", "audit.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
  } catch {
    // the audit log is best-effort; never crash a run over it.
  }
}
