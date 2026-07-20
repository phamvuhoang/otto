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
const RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

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
    findings.push({
      severity,
      file,
      line,
      claim,
      why,
      suggestedFix: fix,
      lens,
    });
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

/** Claim normalization for match/disambiguation: on top of `norm`, strips
 *  markdown emphasis and inline-code backticks so an LLM that reformats a claim
 *  (e.g. wraps a value in backticks) still compares equal. */
const normClaim = (s: string): string => norm(s.replace(/[`*_~]/g, ""));

/** Token-overlap count between two claims (after `normClaim`). Used only to pick
 *  the closest of MULTIPLE candidates sharing one file+line-overlap. */
function claimOverlapScore(a: string, b: string): number {
  const ta = new Set(normClaim(a).split(" ").filter(Boolean));
  const tb = new Set(normClaim(b).split(" ").filter(Boolean));
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

/** Among co-located candidate indices, pick the one whose claim best matches the
 *  verdict's claim: prefer an exact `normClaim` match, else the strictly-highest
 *  token overlap. Returns -1 when genuinely ambiguous (tie or no overlap). */
function pickByClaim(
  indices: readonly number[],
  candidates: readonly Finding[],
  claim: string
): number {
  const target = normClaim(claim);
  const exact = indices.filter(
    (i) => normClaim(candidates[i].claim) === target
  );
  if (exact.length >= 1) return exact[0]; // co-located identical claims are interchangeable
  let best = -1;
  let bestScore = -1;
  let tied = false;
  for (const i of indices) {
    const s = claimOverlapScore(candidates[i].claim, claim);
    if (s > bestScore) {
      bestScore = s;
      best = i;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  }
  return tied || bestScore <= 0 ? -1 : best;
}

/** Tally findings by severity and count how many nits were suppressed by the
 *  low-value suppression rule (i.e. how many nits would be dropped when a
 *  blocker or major is present). */
export function severityCounts(
  findings: Finding[]
): Record<Severity, number> & { suppressed: number } {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, suppressed: 0 };
  for (const f of findings) counts[f.severity]++;
  counts.suppressed = suppressLowValue(findings).suppressed;
  return counts;
}

/** Serialize a finding to its wire line: `SEVERITY | file:line | claim | why | fix?`
 *  (the trailing `| fix` is omitted when there is no suggested fix, and the
 *  `:line` segment is omitted when the finding has no line). Inverse of
 *  `parseFindings` for a single finding — used to write the merged findings file
 *  the verifier reads and, in tests, to build verifier wire input. */
export function findingToWire(f: Finding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  const head = `${f.severity} | ${loc} | ${f.claim} | ${f.why}`;
  return f.suggestedFix ? `${head} | ${f.suggestedFix}` : head;
}

/** Parsed verifier verdicts, mapped back onto the candidate findings. `confirmed`
 *  is ranked (blocker first, stable within a tier); `rejected` keeps candidate
 *  order. `errors` is non-empty when ANY row is malformed, duplicated, unmatched,
 *  severity-mismatched, or when a candidate never received a verdict. */
export type ReviewVerdictParse = {
  confirmed: Finding[];
  rejected: Finding[];
  errors: string[];
};

/** Split a `file` or `file:line`/`file:start-end` token into its parts. */
function parseVerdictLoc(fileRaw: string): { file: string; line?: string } {
  const m = fileRaw.match(/^(.*?):(\d+(?:-\d+)?)$/);
  return m ? { file: m[1], line: m[2] } : { file: fileRaw };
}

/**
 * Strictly parse the verifier's verdict wire format:
 *
 *   `CONFIRMED <severity> | file:line | claim | why`
 *   `REJECTED | file:line | claim | why`
 *
 * Every row maps back to a candidate by LOCATION — normalized `file` plus
 * range-overlap-aware `line` — because the verifier reliably reproduces
 * `file:line` but reformats the free-text claim. A unique candidate at a location
 * matches regardless of claim text; the claim only disambiguates when MULTIPLE
 * candidates share one file+line-overlap. A single `none` line is the
 * empty-candidate signal. The parser is adversarial about the contract: it
 * records an error for a bad status token, a row with fewer than four fields, a
 * CONFIRMED severity that disagrees with the candidate, a row whose location
 * matches no candidate, co-located candidates it cannot disambiguate, a second
 * row hitting an already-matched candidate, a `none` alongside real candidates,
 * and any candidate left without a verdict. Non-row commentary (e.g. a trailing
 * `<verify>…</verify>` tally) is ignored so the verifier's chat reply parses too.
 */
export function parseReviewVerdicts(
  text: string,
  candidates: readonly Finding[]
): ReviewVerdictParse {
  const errors: string[] = [];
  const confirmed: Finding[] = [];
  const rejected: Finding[] = [];
  const matched = new Array(candidates.length).fill(false);
  let sawNone = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes("|")) {
      // A bare `none` is the empty signal; anything else (a tally, prose) is
      // commentary the verifier is allowed to emit and we ignore.
      if (line.toLowerCase() === "none") sawNone = true;
      continue;
    }
    const parts = line.split("|").map((p) => p.trim());
    const statusField = parts[0];
    const words = statusField.split(/\s+/);
    const status = words[0].toUpperCase();
    if (status !== "CONFIRMED" && status !== "REJECTED") {
      errors.push(`bad status token: ${statusField}`);
      continue;
    }
    if (parts.length < 4) {
      errors.push(`malformed verdict row: ${line}`);
      continue;
    }
    const { file, line: vline } = parseVerdictLoc(parts[1]);
    const claim = parts[2];
    // Identity is LOCATION, not verbatim claim text: the model reproduces
    // `file:line` exactly but reformats the free-text claim (backticks, spacing).
    // Collect candidates at this location (file match + line overlap); `locAll`
    // includes already-matched ones so we can tell a duplicate from an unmatched
    // verdict and disambiguate co-located candidates.
    const locAll: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (norm(c.file) === norm(file) && overlaps(c.line, vline))
        locAll.push(i);
    }
    const locFree = locAll.filter((i) => !matched[i]);
    let hitIndex = -1;
    if (locFree.length === 1) {
      // Unique candidate at this location → match regardless of claim text.
      hitIndex = locFree[0];
    } else if (locFree.length > 1) {
      // Multiple candidates share the location → disambiguate by claim.
      hitIndex = pickByClaim(locFree, candidates, claim);
      if (hitIndex === -1) {
        errors.push(
          `ambiguous verdict (multiple candidates at ${parts[1]}): ${claim}`
        );
        continue;
      }
    }
    if (hitIndex === -1) {
      errors.push(
        `${locAll.length > 0 ? "duplicate" : "unmatched"} verdict for: ${parts[1]} | ${claim}`
      );
      continue;
    }
    matched[hitIndex] = true; // consume the candidate even on a severity error
    const candidate = candidates[hitIndex];
    if (status === "CONFIRMED") {
      const sev = words[1] ? asSeverity(words[1]) : null;
      if (!sev) {
        errors.push(`missing/invalid confirmed severity: ${statusField}`);
        continue;
      }
      if (sev !== candidate.severity) {
        errors.push(
          `severity mismatch for ${parts[1]}: verdict ${sev} vs candidate ${candidate.severity}`
        );
        continue;
      }
      confirmed.push({ ...candidate });
    } else {
      rejected.push({ ...candidate });
    }
  }

  if (sawNone && candidates.length > 0) {
    errors.push("verifier returned `none` but there were candidate findings");
  }
  for (let i = 0; i < candidates.length; i++) {
    if (!matched[i]) {
      const c = candidates[i];
      const loc = c.line ? `${c.file}:${c.line}` : c.file;
      errors.push(`missing verdict for candidate: ${loc} | ${c.claim}`);
    }
  }

  return { confirmed: rankFindings(confirmed), rejected, errors };
}

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
