/**
 * Read deduplication (issue #62 P7, slice 7).
 *
 * Otto's `@spill` tags re-run a command each iteration and write its full output
 * to a spill file the agent then `Read`s. For file-content spills (issue bodies,
 * the HEAD patch, large reference files) that content is frequently UNCHANGED from
 * the prior iteration, yet it is re-spilled and re-read in full every turn — pure
 * accumulated context, not necessary work. This module tracks what has already
 * been read this run by a cheap content fingerprint, so the loop can later replace
 * an unchanged re-read with a short "already read, unchanged" reference instead of
 * the full content.
 *
 * Pure + INERT on the loop: nothing here runs a stage, spills a file, or changes
 * behavior. Wiring it into the `@spill` path is a later slice; this is the
 * substrate, mirroring slices 5 (`boundLearnings`) and 6 (`compactCommits`).
 *
 * Imports nothing (no cycle risk): the fingerprint is a small inline hash rather
 * than `node:crypto`, keeping the module pure and dependency-free.
 */

/** First read this run / unchanged since last read / content differs. */
export type ReadStatus = "first" | "unchanged" | "changed";

/** The last fingerprint seen for a path this run. */
export type ReadFingerprint = {
  path: string;
  /** Cheap deterministic content fingerprint (`<length>-<hash>`). */
  fingerprint: string;
  /** Byte length of the recorded content. */
  chars: number;
};

/** Path → last fingerprint seen this run. Carried across iterations by the loop. */
export type ReadLedger = {
  seen: Record<string, ReadFingerprint>;
};

/** The decision for a single read. */
export type DedupResult = {
  path: string;
  status: ReadStatus;
  fingerprint: string;
  chars: number;
  /** Chars that need NOT be re-spilled because the content is unchanged. */
  savedChars: number;
};

/** Run-level tally over many reads — the "what was deduplicated" reporting surface. */
export type DedupSummary = {
  total: number;
  first: number;
  unchanged: number;
  changed: number;
  savedChars: number;
};

/** A fresh, empty ledger for the start of a run. */
export function emptyReadLedger(): ReadLedger {
  return { seen: {} };
}

/**
 * Cheap deterministic content fingerprint: FNV-1a 32-bit, prefixed with the exact
 * content length. Pairing the hash with the length means two contents of different
 * length can never share a fingerprint; a hash collision (astronomically unlikely)
 * would at worst treat changed content as unchanged, and the inverse — a mismatch
 * — only ever causes a safe re-spill, so the failure mode is conservative.
 */
export function fingerprintContent(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${content.length}-${(h >>> 0).toString(36)}`;
}

/**
 * Decide whether `content` for `path` is a first read, an unchanged re-read
 * (dedupable — saves its full chars), or changed (must be re-spilled), and return
 * the updated ledger. Pure: the input ledger is never mutated (a fresh copy is
 * returned), mirroring the copy-not-mutate discipline of `memory.ts` /
 * `iteration-compaction.ts`.
 */
export function recordRead(
  ledger: ReadLedger,
  path: string,
  content: string
): { ledger: ReadLedger; result: DedupResult } {
  const fingerprint = fingerprintContent(content);
  const chars = content.length;
  const prior = ledger.seen[path];
  let status: ReadStatus;
  if (!prior) status = "first";
  else if (prior.fingerprint === fingerprint) status = "unchanged";
  else status = "changed";
  const result: DedupResult = {
    path,
    status,
    fingerprint,
    chars,
    savedChars: status === "unchanged" ? chars : 0,
  };
  const nextLedger: ReadLedger = {
    seen: { ...ledger.seen, [path]: { path, fingerprint, chars } },
  };
  return { ledger: nextLedger, result };
}

/** Tally a set of read decisions into run-level counts + total chars saved. */
export function summarizeReads(results: DedupResult[]): DedupSummary {
  const summary: DedupSummary = {
    total: results.length,
    first: 0,
    unchanged: 0,
    changed: 0,
    savedChars: 0,
  };
  for (const r of results) {
    summary[r.status] += 1;
    summary.savedChars += r.savedChars;
  }
  return summary;
}

/**
 * Render the short reference that replaces a full re-spill when a read is
 * unchanged — citing the path, the chars saved, and where the already-read copy
 * lives, so the prompt stays honest about what was deduplicated (the issue's
 * "avoid re-spilling unchanged content"). Only meaningful for an `unchanged`
 * result; the caller spills fresh for `first`/`changed`.
 */
export function formatReadReference(
  result: DedupResult,
  opts: { refPath: string }
): string {
  return (
    `_Read deduplicated: \`${result.path}\` is unchanged since it was read ` +
    `earlier this run (saved ${result.savedChars} chars) — re-use the copy at ` +
    `${opts.refPath}._`
  );
}
