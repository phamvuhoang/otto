/**
 * Exact diff-line mapping for formal GitHub reviews (P32 Task 14 — Slice 3).
 *
 * A formal review may only attach an inline comment to a line GitHub recognises
 * as part of the pull request's diff. This module turns the byte-exact
 * `git diff --unified=0` artifact (Task 7's `pr.diff`) into a per-path table of
 * commentable positions, then maps each confirmed finding onto an EXACT diff
 * line — or, when no exact line exists, marks it `inlineEligible:false` so the
 * publisher routes it to the review body instead of guessing a line.
 *
 * Two invariants the caller relies on:
 *  - a wrong line is worse than no line: a finding is mapped ONLY when its
 *    (path, line) is literally present in the diff — never approximated;
 *  - a finding is never dropped: {@link mapFindingsToDiff} is 1:1 with its
 *    input, so an unmappable confirmed finding still reaches the review body.
 *
 * Pure — no I/O, no GitHub, no model work.
 */

import type { PublishedReviewFinding } from "./pr-review-output.js";
import type { Finding } from "./review-severity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One commentable position in the diff: a path, a side, and its line number. */
export type DiffLine = {
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
};

/** Per-path list of commentable diff positions, keyed by the normalized path. */
export type DiffLineMap = ReadonlyMap<string, readonly DiffLine[]>;

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Strip a diff header path (`a/<p>`, `b/<p>`) of its prefix, dropping a git
 * disambiguation trailing tab (present when the path contains whitespace).
 * Returns `null` for `/dev/null`.
 */
function parseDiffHeaderPath(raw: string): string | null {
  let s = raw;
  const tab = s.indexOf("\t");
  if (tab >= 0) s = s.slice(0, tab);
  if (s === "/dev/null") return null;
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

/**
 * Normalize a finding's file path to the same key space as the diff map by
 * removing a leading `./` (repeated) and a single `a/` or `b/` prefix.
 */
export function normalizeFindingPath(path: string): string {
  let s = path;
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

/** Parse a finding `line` field (`"42"` or `"42-45"`) to an inclusive range. */
function parseLineRange(line: string | undefined): [number, number] | null {
  if (line === undefined) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(line.trim());
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (
    !Number.isSafeInteger(lo) ||
    !Number.isSafeInteger(hi) ||
    lo <= 0 ||
    hi < lo
  ) {
    return null;
  }
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Zero-context diff parser
// ---------------------------------------------------------------------------

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@[ section]` — anchored so a
// trailing function/section heading is ignored.
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a `--unified=0` diff into a {@link DiffLineMap}. For each file the
 * destination path comes from the `+++ b/<path>` line (or the `--- a/<path>`
 * source when the destination is `/dev/null`, i.e. a deletion). Within each
 * `@@ -a[,b] +c[,d] @@` hunk the removed (`-`) rows map to `LEFT` starting at
 * the old-file line `a`, the added (`+`) rows map to `RIGHT` starting at the
 * new-file line `c`, and each hunk header resets both counters to its own
 * absolute start (no cross-hunk offset accumulation).
 *
 * Body rows are consumed ONLY while a hunk is active, so a GIT binary patch —
 * which has no `@@` header and whose base85 payload lines may themselves begin
 * with `+`/`-` — contributes no phantom mappings.
 */
export function parseZeroContextDiff(diff: string): DiffLineMap {
  const map = new Map<string, DiffLine[]>();
  let currentPath: string | null = null;
  let sourcePath: string | null = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const record = (side: "LEFT" | "RIGHT", line: number): void => {
    if (currentPath === null) return;
    let list = map.get(currentPath);
    if (!list) {
      list = [];
      map.set(currentPath, list);
    }
    list.push({ path: currentPath, side, line });
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      sourcePath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      sourcePath = parseDiffHeaderPath(line.slice(4));
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const dest = parseDiffHeaderPath(line.slice(4));
      currentPath = dest ?? sourcePath;
      inHunk = false;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = currentPath !== null;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      record("RIGHT", newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      record("LEFT", oldLine);
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a marker row that advances nothing.
    } else if (line.startsWith(" ")) {
      // A context row (rare under --unified=0) advances both sides.
      oldLine++;
      newLine++;
    } else {
      // Any other line (blank tail, next section) ends the hunk body.
      inHunk = false;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Finding → diff mapping
// ---------------------------------------------------------------------------

/**
 * Place a single finding on the exact diff. When the finding's normalized path
 * and a line in its range are present in `map`, the finding becomes
 * `inlineEligible:true` with the resolved `side`/`mappedLine` — RIGHT (head)
 * lines are preferred over LEFT (base) lines, and within a range the lowest
 * mappable line wins. A finding with no line, a binary/whole-file target, a
 * path outside the diff, or a line the diff does not contain becomes
 * `inlineEligible:false` with NO placement (the publisher routes it to the
 * review body). The original finding fields are always preserved.
 */
export function mapFindingToDiff(
  finding: Finding,
  map: DiffLineMap
): PublishedReviewFinding {
  const entries = map.get(normalizeFindingPath(finding.file));
  const range = parseLineRange(finding.line);
  if (!entries || !range) {
    return { ...finding, inlineEligible: false };
  }
  const [lo, hi] = range;
  for (let ln = lo; ln <= hi; ln++) {
    if (entries.some((e) => e.side === "RIGHT" && e.line === ln)) {
      return {
        ...finding,
        side: "RIGHT",
        mappedLine: ln,
        inlineEligible: true,
      };
    }
  }
  for (let ln = lo; ln <= hi; ln++) {
    if (entries.some((e) => e.side === "LEFT" && e.line === ln)) {
      return { ...finding, side: "LEFT", mappedLine: ln, inlineEligible: true };
    }
  }
  return { ...finding, inlineEligible: false };
}

/**
 * Map every confirmed finding onto the exact diff (parsed once). The result is
 * 1:1 with `findings` — no finding is ever dropped — so an unmappable finding
 * still reaches the review body as an `inlineEligible:false` entry.
 */
export function mapFindingsToDiff(
  findings: readonly Finding[],
  diff: string
): PublishedReviewFinding[] {
  const map = parseZeroContextDiff(diff);
  return findings.map((f) => mapFindingToDiff(f, map));
}
