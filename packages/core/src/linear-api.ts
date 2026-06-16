import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * A normalized Linear issue reference. Discriminated so callers know whether to
 * query Linear by its human identifier (`ENG-123`) or by the issue UUID.
 */
export type LinearRef =
  | { kind: "identifier"; identifier: string }
  | { kind: "uuid"; uuid: string };

// A Linear issue identifier: team key (letter then letters/digits) + "-" +
// positive number (no leading zero — mirrors parseIssueRef strictness).
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/;
// Issue UUID (RFC-4122 shape; we don't validate the version nibble).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// `linear.app/<workspace>/issue/<IDENTIFIER>[/<slug>...]` — the identifier is
// the path segment after `/issue/`.
const URL_IDENTIFIER_RE = /\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:[/?#]|$)/;

/**
 * Normalize a user-supplied Linear issue reference to a {@link LinearRef}.
 * Accepts a Linear identifier (`ENG-123`), an issue UUID, or a Linear issue
 * URL (`https://linear.app/acme/issue/ENG-123/slug`). Team keys are uppercased
 * to Linear's canonical form; UUIDs are lowercased. Throws on anything else.
 *
 * SECURITY: like {@link parseIssueRef} in cli-help.ts, the normalized value is
 * the only part of a ref that may reach a shell (via a static template command
 * reading an env var). The identifier/UUID regexes admit only `[A-Za-z0-9-]`,
 * so a value like `$(rm -rf ~)` can never survive parsing.
 */
export function parseLinearRef(raw: string): LinearRef {
  const s = raw.trim();

  const urlMatch = s.match(URL_IDENTIFIER_RE);
  if (urlMatch) {
    return { kind: "identifier", identifier: urlMatch[1].toUpperCase() };
  }
  if (UUID_RE.test(s)) {
    return { kind: "uuid", uuid: s.toLowerCase() };
  }
  if (IDENTIFIER_RE.test(s)) {
    return { kind: "identifier", identifier: s.toUpperCase() };
  }
  throw new Error(
    `--issue must be a Linear identifier (ENG-123), an issue UUID, or a Linear issue URL, got: ${JSON.stringify(raw)}`
  );
}

/** A resolved Linear credential plus where it came from (for `--print-config`). */
export type LinearAuth = { token: string; source: string };

/**
 * Injectable env/fs so {@link resolveLinearAuth} stays pure and unit-testable
 * without real env vars or a real home dir. Mirrors {@link PreflightProbes}.
 */
export type LinearAuthDeps = {
  env: NodeJS.ProcessEnv;
  /** Read a file's contents, or null if it is absent/unreadable. */
  readFile: (path: string) => string | null;
  /** Home directory holding the credential file. */
  home: string;
};

/** Canonical location of the stored Linear API key (outside any repo). */
export function linearConfigPath(home: string): string {
  return join(home, ".config", "otto", "linear.json");
}

const defaultAuthDeps: LinearAuthDeps = {
  env: process.env,
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  home: homedir(),
};

/**
 * Resolve a Linear API key with precedence `OTTO_LINEAR_API_KEY` →
 * `LINEAR_API_KEY` → `~/.config/otto/linear.json` (`{ "type": "apiKey",
 * "token": "..." }`). Returns the token and its source, or null when no source
 * yields a usable (non-empty) token. The config shape is kept extensible for a
 * future OAuth `type`.
 */
export function resolveLinearAuth(
  deps: LinearAuthDeps = defaultAuthDeps
): LinearAuth | null {
  const { env, readFile, home } = deps;

  for (const name of ["OTTO_LINEAR_API_KEY", "LINEAR_API_KEY"] as const) {
    const token = env[name]?.trim();
    if (token) return { token, source: name };
  }

  const path = linearConfigPath(home);
  const raw = readFile(path);
  if (raw != null) {
    try {
      const token = (JSON.parse(raw) as { token?: unknown }).token;
      if (typeof token === "string" && token.trim()) {
        return { token: token.trim(), source: path };
      }
    } catch {
      // malformed config → no credential from this source
    }
  }

  return null;
}
