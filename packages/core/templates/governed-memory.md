<!--
  Governed-memory compaction tiers + record-writing prose for the LEARNINGS loop
  (issue #42 slice 6b). No otto src code is behind this — the agent follows the
  template — so it is @include'd ONCE by each playbook's LEARNINGS section
  (prompt.md for afk; ghprompt-workflow.md for every *afk* provider mode) and
  pinned at the render-contract level, the same drift-proofing as
  quality-report.md / acceptance-prompts.md. Records under .otto/memory/ are the
  governed source of truth; LEARNINGS.md is their human-readable projection.
-->

## Memory compaction tiers

Otto keeps memory in four tiers — smallest lives in the prompt, largest lives on
disk. Put each thing in the tier it belongs to so prompt size from memory stays
bounded and explainable:

- **Active context** — this prompt: the `<commits>`, `<learnings>`, and issue/
  inputs blocks. Rebuilt every iteration, never hand-edited; keep it lean.
- **Summarized state** — `./.otto/LEARNINGS.md`: the compact, human-readable
  projection of durable memory, injected wholesale into every stage. Terse
  bullets only — it is the bounded budget the active context spends on memory.
- **Reconstructable artifacts** — `.otto-tmp/logs/*.ndjson`, rendered prompts,
  and the run bundles under `.otto/runs/`. Regenerable evidence, not memory;
  read them with `otto-inspect`, never curate them by hand.
- **Durable memory** — `./.otto/memory/<id>.json`: governed records carrying
  provenance, freshness, and scope. The source of truth that survives across
  runs; LEARNINGS.md is projected from it.

## Writing a governed memory record

When you record a new durable learning, capture it in BOTH places:

1. A terse bullet in the right `./.otto/LEARNINGS.md` section (the human
   projection above) — unchanged from before.
2. A governed record `./.otto/memory/<id>.json` so the learning carries
   provenance/freshness/scope and shows up in `otto-memory audit`. Use a
   sortable id (an ISO timestamp with `:` and `.` replaced by `-`) and these
   fields:

   - `id`, `content` (the same learning text) — required.
   - `category`: `convention` | `gotcha` | `decision` | `dead-end` (the
     LEARNINGS.md section it projects into).
   - `taskKey`: this run's task key (e.g. `issue-42`); `scope`: the file/module
     globs it applies to (`[]` = repo-wide).
   - `confidence` (0..1); `trust`: `unverified` for a fresh run-produced learning
     (a maintainer promotes it to `trusted`); `status`: `active`.
   - `createdAt` (ISO now); `useCount`: 0.
   - Optional freshness — `expiresAt` and/or `revalidateAfterDays` — only when
     the learning is time-bounded (e.g. "until the codex adapter lands").

If a new learning contradicts an older record, supersede the older one (set its
`status` to `superseded` and your new record's `supersedes` to the old id) rather
than letting the two silently diverge.

Inspect the governed set any time with `otto-memory audit` (stale / conflicting /
frequently-used) and regenerate the projection with `otto-memory project`. Records
are git-tracked (under `.otto/`, like LEARNINGS.md) and committed WITH the task
commit — never a separate commit.
