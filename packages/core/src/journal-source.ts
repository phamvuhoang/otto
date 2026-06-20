/** Select a journal-worthy memory record + derive its forbidden terms (#67 P12). */
import type { MemoryRecord } from "./memory.js";
import { memoryStatus } from "./memory.js";

/**
 * Pick the best journal candidate: an ACTIVE record in a journal-worthy category
 * that has not already been posted, ranked by confidence (ties → newer). Returns
 * null when nothing qualifies.
 */
export function selectCandidate(
  records: MemoryRecord[],
  opts: { categories: string[]; postedIds: Set<string>; now: Date }
): MemoryRecord | null {
  const eligible = records.filter(
    (r) =>
      memoryStatus(r, opts.now) === "active" &&
      r.category != null &&
      opts.categories.includes(r.category) &&
      !opts.postedIds.has(r.id)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) =>
    b.confidence !== a.confidence
      ? b.confidence - a.confidence
      : b.createdAt.localeCompare(a.createdAt)
  );
  return eligible[0];
}

/**
 * Identifiers carried by a record that must not survive into a post: its
 * taskKey, its sourceRun id, and the word-ish parts of its scope globs. Fed into
 * the gate's `forbiddenTerms` so a leaked source term is denied at Gate 2.
 */
export function forbiddenTermsFor(record: MemoryRecord): string[] {
  const terms = new Set<string>();
  if (record.taskKey) terms.add(record.taskKey);
  if (record.sourceRun) terms.add(record.sourceRun);
  for (const glob of record.scope) {
    for (const part of glob.split(/[/*.\s]+/)) {
      if (part.length >= 3) terms.add(part);
    }
  }
  return [...terms];
}
