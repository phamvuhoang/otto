/**
 * Severity model + structured-finding plumbing for the review panel (P14).
 * Pure — no I/O. Lenses and the verifier emit pipe-delimited finding lines;
 * this module parses, ranks, dedupes, and applies the nit-suppression rule.
 */

export type Severity = "blocker" | "major" | "minor" | "nit";

export type Finding = {
  severity: Severity;
  file: string;
  line?: string;
  claim: string;
  why: string;
  suggestedFix?: string;
  lens?: string;
};

const ORDER: Severity[] = ["blocker", "major", "minor", "nit"];
const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

function asSeverity(token: string): Severity | null {
  const t = token.trim().toLowerCase();
  return (ORDER as string[]).includes(t) ? (t as Severity) : null;
}

/** Wire format, one finding per line: `SEVERITY | file:line | claim | why | fix?`
 *  `file:line` may be just `file`; the trailing `fix` field is optional. A line
 *  that does not yield a valid severity + ≥4 fields is dropped (counted). */
export function parseFindings(
  text: string,
  lens?: string
): { findings: Finding[]; dropped: number } {
  const findings: Finding[] = [];
  let dropped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.includes("|")) continue;
    const parts = raw.split("|").map((p) => p.trim());
    const severity = asSeverity(parts[0]);
    if (!severity || parts.length < 4) {
      dropped++;
      continue;
    }
    const [fileRaw, claim, why] = [parts[1], parts[2], parts[3]];
    const fix = parts[4]?.length ? parts[4] : undefined;
    const m = fileRaw.match(/^(.*?):(\d+(?:-\d+)?)$/);
    const file = m ? m[1] : fileRaw;
    const line = m ? m[2] : undefined;
    findings.push({ severity, file, line, claim, why, suggestedFix: fix, lens });
  }
  return { findings, dropped };
}

/** Stable sort by severity (blocker first); input order preserved within a tier. */
export function rankFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

/** Cursor output hierarchy: if any blocker/major exists, drop nits so synth and
 *  the report stay high-signal. Minors are kept (they are cheap and often real). */
export function suppressLowValue(findings: Finding[]): {
  kept: Finding[];
  suppressed: number;
} {
  const hasHigh = findings.some(
    (f) => f.severity === "blocker" || f.severity === "major"
  );
  if (!hasHigh) return { kept: findings, suppressed: 0 };
  const kept = findings.filter((f) => f.severity !== "nit");
  return { kept, suppressed: findings.length - kept.length };
}

function range(line?: string): [number, number] | null {
  if (!line) return null;
  const m = line.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const lo = Number(m[1]);
  return [lo, m[2] ? Number(m[2]) : lo];
}

function overlaps(a?: string, b?: string): boolean {
  const ra = range(a);
  const rb = range(b);
  if (!ra || !rb) return a === b; // no parsable range → exact-string match
  return ra[0] <= rb[1] && rb[0] <= ra[1];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Merge findings pointing at the same place: same file, overlapping line range,
 *  and the same normalized claim. Keeps the highest severity, unions the raising
 *  lenses (comma-joined, de-duped, sorted), and concatenates distinct why-text. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const hit = out.find(
      (g) =>
        g.file === f.file &&
        norm(g.claim) === norm(f.claim) &&
        overlaps(g.line, f.line)
    );
    if (!hit) {
      out.push({ ...f });
      continue;
    }
    if (RANK[f.severity] < RANK[hit.severity]) hit.severity = f.severity;
    const lenses = new Set(
      [hit.lens, f.lens].filter(Boolean).flatMap((l) => l!.split(", "))
    );
    hit.lens = [...lenses].sort().join(", ") || undefined;
    if (f.why && !hit.why.includes(f.why))
      hit.why = hit.why ? `${hit.why}; ${f.why}` : f.why;
  }
  return out;
}
