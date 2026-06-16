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
