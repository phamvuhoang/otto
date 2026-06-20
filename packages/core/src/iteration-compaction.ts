/**
 * Inter-iteration compaction (issue #62 P7, slice 6).
 *
 * Otto spawns a fresh `claude --print` each iteration, so no live transcript is
 * carried forward; the only prior-iteration state that fills the new prompt's
 * window is the `<commits>` block —
 * `git log -n 5 --format="%H%n%ad%n%B---" --date=short` (recent commit
 * summaries). That block is count-bounded (5) but each commit body is unbounded,
 * so a long run with verbose commit bodies keeps inflating it. This module
 * bounds it: keep the most recent commits in full and *summarize* the older ones
 * (degrade to their subject line) once a char budget is exceeded — "summarize
 * prior iterations into a bounded state rather than carrying the full transcript
 * forward."
 *
 * Pure + INERT on the loop: nothing here runs a stage or changes behavior.
 * Wiring this into the template's commit injection is a later slice; this is the
 * substrate, mirroring how slice 5 (`boundLearnings`) shipped pure-then-wired.
 */

export type CommitEntry = {
  hash: string;
  date: string;
  /** First non-empty line of the body — the commit's one-line summary. */
  subject: string;
  /** Full commit body (subject + the rest), trimmed. */
  body: string;
};

export type CompactedCommits = {
  /** Newest commits, kept with their full body. */
  kept: CommitEntry[];
  /** Older commits, summarized to subject-only (not dropped). */
  compacted: CommitEntry[];
  /** Rendered chars of the kept (full) entries. */
  keptChars: number;
  /** Rendered chars of the compacted (subject-only) entries. */
  compactedChars: number;
  /** Body chars removed by degrading the compacted entries to their subject. */
  savedChars: number;
  /** The char budget applied. */
  budgetChars: number;
};

/**
 * Default budget for the carried-forward commit block. Tuned so a normal history
 * (≤5 short `git log` commits) stays fully intact, while a verbose or long tail
 * is summarized rather than re-fed in full each iteration.
 */
export const DEFAULT_COMMITS_BUDGET_CHARS = 2400;

const HASH_RE = /^[0-9a-f]{7,40}$/i;

function renderFull(e: CommitEntry): string {
  return `${e.hash}\n${e.date}\n${e.body}`;
}

function renderCompact(e: CommitEntry): string {
  return `${e.hash}\n${e.date}\n${e.subject}`;
}

/**
 * Parse `git log --format="%H%n%ad%n%B---"` output into commit entries. Each
 * record is a `---`-delimited chunk of `hash`, `date`, then the body; a chunk
 * whose first line is not a commit hash (e.g. the `No commits found` fallback) is
 * skipped. Never throws — malformed input yields `[]` or fewer entries.
 */
export function parseCommitLog(raw: string): CommitEntry[] {
  const entries: CommitEntry[] = [];
  for (const chunk of raw.split(/^---$/m)) {
    const lines = chunk.split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length < 3) continue;
    const hash = lines[0].trim();
    if (!HASH_RE.test(hash)) continue;
    const date = lines[1].trim();
    const bodyLines = lines.slice(2);
    const body = bodyLines.join("\n").trim();
    const subject = (bodyLines.find((l) => l.trim() !== "") ?? "").trim();
    entries.push({ hash, date, subject, body });
  }
  return entries;
}

/**
 * Keep the newest commits in full and summarize the rest, reporting what was
 * compacted (issue #62 P7 slice 6). Commits are taken newest-first (the order
 * `git log` emits): each is kept full while the cumulative full-rendered chars
 * stay within the budget; the first overflow — and every commit after it — is
 * degraded to subject-only, giving a clean "kept the most recent that fit"
 * boundary. Pure.
 */
export function compactCommits(
  commits: CommitEntry[],
  ctx: { maxChars?: number } = {}
): CompactedCommits {
  const budgetChars = ctx.maxChars ?? DEFAULT_COMMITS_BUDGET_CHARS;
  const kept: CommitEntry[] = [];
  const compacted: CommitEntry[] = [];
  let keptChars = 0;
  let full = false;
  for (const c of commits) {
    const fullLen = renderFull(c).length;
    if (!full && keptChars + fullLen <= budgetChars) {
      kept.push(c);
      keptChars += fullLen;
    } else {
      full = true;
      compacted.push(c);
    }
  }
  const compactedChars = compacted.reduce(
    (sum, c) => sum + renderCompact(c).length,
    0
  );
  const savedChars = compacted.reduce(
    (sum, c) => sum + (renderFull(c).length - renderCompact(c).length),
    0
  );
  return { kept, compacted, keptChars, compactedChars, savedChars, budgetChars };
}

/**
 * Render a compacted set back into a `<commits>`-style body — kept entries in
 * full, compacted entries as subject-only — preserving newest-first order, with
 * a one-line note when the budget summarized older commits (so the prompt is
 * honest about what was condensed; the issue's "report what was dropped"). When
 * nothing was compacted this is the unmodified full block.
 */
export function formatCompactedCommits(c: CompactedCommits): string {
  const rendered = [...c.kept.map(renderFull), ...c.compacted.map(renderCompact)];
  const body = rendered.map((r) => `${r}\n---`).join("\n");
  if (c.compacted.length === 0) return body;
  return (
    body +
    `\n_Compacted: ${c.compacted.length} older commit(s) summarized to their ` +
    `subject (saved ${c.savedChars} chars) to keep prior-iteration context ` +
    `within the ${c.budgetChars}-char budget._`
  );
}
