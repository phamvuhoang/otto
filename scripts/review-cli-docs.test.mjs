// Documentation contract test for P32 automated pull-request code review
// (otto-review). Pins that README.md and docs/CLI.md (plus the relevant
// slices of docs/ARCHITECTURE.md and docs/HARNESS_ROADMAP_PHASE6.md) actually
// document the shipped otto-review CLI/behavior — flags, env, defaults,
// mutual-exclusion/validation rules, provenance, persistence paths, trust
// boundary, idempotency, and the P32 roadmap entry — so a doc can never drift
// silently from what packages/core/src/review-cli.ts et al. actually do.
// Run via `pnpm test` (node --test). No build / network needed; reads the
// markdown/source directly as strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readDoc = (...p) => readFileSync(join(root, ...p), "utf8");

const readme = readDoc("README.md");
const cli = readDoc("docs", "CLI.md");
const architecture = readDoc("docs", "ARCHITECTURE.md");
const roadmap = readDoc("docs", "HARNESS_ROADMAP_PHASE6.md");
const p32Spec = readFileSync(
  join(
    root,
    "docs",
    "superpowers",
    "specs",
    "2026-07-18-automated-pr-code-review-design.md"
  ),
  "utf8"
);
const p32Plan = readFileSync(
  join(
    root,
    "docs",
    "superpowers",
    "plans",
    "2026-07-18-automated-pr-code-review.md"
  ),
  "utf8"
);

// Everything otto-review-specific in one combined haystack, for assertions
// that don't care which particular doc carries the fact.
const all = [readme, cli, architecture, roadmap].join("\n\n");

function assertAllInclude(haystack, needles, context) {
  for (const needle of needles) {
    assert.ok(
      haystack.includes(needle),
      `${context} is missing ${JSON.stringify(needle)}`
    );
  }
}

// ---------------------------------------------------------------------------
// README: quick-start recipes
// ---------------------------------------------------------------------------

test("README documents the otto-review quick-start recipes verbatim", () => {
  assert.ok(
    readme.includes("otto-review"),
    "README never mentions otto-review"
  );
  const recipeLines = [
    "gh label create otto-review --repo owner/name",
    "otto-review --repo owner/name --pr 123",
    "otto-review --repo owner/name --pr 123 --spec-issue 456",
    "otto-review --repo owner/name --pr 123 --spec-file docs/feature.md",
    'otto-review --repo owner/name --pr 123 --prompt "focus on cancellation"',
    "otto-review --repo owner/name --watch --detach --notify",
    "otto-review --repo owner/name --watch --github-review",
  ];
  assertAllInclude(readme, recipeLines, "README quick-start block");
});

test("README documents one-shot and watch recipes together in context", () => {
  const section = readme.slice(readme.indexOf("otto-review"));
  assert.ok(
    section.includes("--pr"),
    "README otto-review section missing --pr"
  );
  assert.ok(
    section.includes("--watch"),
    "README otto-review section missing --watch"
  );
});

// ---------------------------------------------------------------------------
// Default label / output behavior
// ---------------------------------------------------------------------------

test("docs state the default label and the mode-dependent default output", () => {
  assertAllInclude(
    all,
    [
      "otto-review", // the default label name itself
      "text", // one-shot default output
      "comment", // watch default output
    ],
    "combined docs"
  );
  assert.ok(
    /default[^.]*otto-review/i.test(cli) ||
      /otto-review[^.]*default/i.test(cli),
    "docs/CLI.md never states the default label is otto-review"
  );
  assert.ok(
    /text[^.]*one-shot|one-shot[^.]*text/i.test(cli),
    "docs/CLI.md never states one-shot defaults to text output"
  );
  assert.ok(
    /comment[^.]*watch|watch[^.]*comment/i.test(cli),
    "docs/CLI.md never states watch defaults to comment output"
  );
});

// ---------------------------------------------------------------------------
// Every P32 flag / env / config field
// ---------------------------------------------------------------------------

test("docs/CLI.md documents every otto-review flag", () => {
  const flags = [
    "--repo",
    "--pr",
    "--watch",
    "--watch-interval",
    "--label",
    "--review-skill",
    "--spec-issue",
    "--spec-file",
    "--prompt",
    "--output",
    "--output-file",
    "--github-review",
    "--agent",
    "--fallback-agent",
    "--auto-switch-on-limit",
    "--model-routing",
    "--token-mode",
    "--context-compressor",
    "--budget",
    "--cooldown",
    "--max-retries",
    "--detach",
    "--log",
    "--notify",
    "--verbose",
    "--print-config",
    "--help",
    "--version",
  ];
  assertAllInclude(cli, flags, "docs/CLI.md otto-review section");
});

test("docs/CLI.md documents every otto-review env var and config field", () => {
  assertAllInclude(
    cli,
    [
      "OTTO_REVIEW_LABEL",
      "OTTO_REVIEW_SKILL",
      "OTTO_REVIEW_OUTPUT",
      "pullRequestReview",
    ],
    "docs/CLI.md otto-review section"
  );
});

test("docs/CLI.md states review-input flags have NO env/config equivalent", () => {
  assert.ok(
    /--spec-issue.*--spec-file.*--prompt|--spec-issue\/--spec-file\/--prompt/s.test(
      cli
    ),
    "docs/CLI.md never groups --spec-issue/--spec-file/--prompt together"
  );
  assert.ok(
    /no environment variable or config (?:file )?equivalent|no env(?:ironment)?\/config equivalent|invocation-only/i.test(
      cli
    ),
    "docs/CLI.md never states review-input flags have no env/config equivalent"
  );
});

// ---------------------------------------------------------------------------
// Mutual exclusion, validation, provenance, persistence, no-secret warning
// ---------------------------------------------------------------------------

test("docs/CLI.md documents review-input mutual exclusion and validation rules", () => {
  assert.ok(
    /at most one of.*--spec-issue.*--spec-file.*--prompt/is.test(cli),
    "docs/CLI.md never states at most one of --spec-issue/--spec-file/--prompt"
  );
  assert.ok(
    /exactly one of.*--pr.*--watch/is.test(cli),
    "docs/CLI.md never states exactly one of --pr/--watch is required"
  );
  assert.ok(
    cli.includes("--output-file") && /markdown/i.test(cli),
    "docs/CLI.md never ties --output-file to --output markdown"
  );
});

test("docs document review-input provenance (kind/source/fingerprint/artifact)", () => {
  assertAllInclude(
    all,
    ["kind", "source", "fingerprint", "artifactPath"],
    "combined docs"
  );
});

test("docs document review-input persistence under .otto/runs/<run-id>/", () => {
  assert.ok(
    all.includes(".otto/runs/") && all.includes("review-input.md"),
    "docs never document the .otto/runs/<run-id>/review-input.md artifact path"
  );
});

test("docs document the prompt no-secret warning (never echoed, only length)", () => {
  assert.ok(
    /direct \(<?N?>? ?chars\)|direct \(\d|never echo|not echo|redact/i.test(
      cli
    ),
    "docs/CLI.md never document that a direct --prompt is never echoed"
  );
});

test("docs document same-repository issue syntax and workspace file constraints", () => {
  assert.ok(
    /issue/i.test(cli) && /\.txt|\.md|\.markdown/.test(cli),
    "docs/CLI.md missing issue syntax or workspace file extension constraints"
  );
});

test("docs document watch-wide input behavior and changed-input reruns", () => {
  assert.ok(
    /re-resolved|resolved fresh|every poll/i.test(cli),
    "docs/CLI.md never documents that watch re-resolves review input each poll"
  );
  assert.ok(
    /new (?:composite )?review|changed input|new fingerprint/i.test(cli),
    "docs/CLI.md never documents that changed input triggers a new review"
  );
});

// ---------------------------------------------------------------------------
// One-review-per-head-and-fingerprint semantics + composite state paths
// ---------------------------------------------------------------------------

test("docs document one-review-per-head-and-input-fingerprint semantics", () => {
  assert.ok(
    /head sha.*fingerprint|fingerprint.*head sha|composite identity/is.test(
      all
    ),
    "docs never document the composite (head, input fingerprint) identity"
  );
  assert.ok(
    /exactly once/i.test(all),
    "docs never state a composite identity is reviewed exactly once"
  );
});

test("docs document the composite review-state path under .otto/review-state/", () => {
  assert.ok(
    all.includes(".otto/review-state/"),
    "docs never mention the .otto/review-state/ path"
  );
  assert.ok(
    /github\/<owner>\/<repo>\/<pr>\/<head-sha>\/<fingerprint>\.json|github\/.*owner.*repo.*pr.*head.*fingerprint/i.test(
      all
    ),
    "docs never spell out the composite state path shape"
  );
});

// ---------------------------------------------------------------------------
// Skill validation rules
// ---------------------------------------------------------------------------

test("docs document explicit review-skill validation rules", () => {
  assertAllInclude(
    all,
    ["builtin:otto-code-review", "validated"],
    "combined docs"
  );
  assert.ok(
    /afk-safe|stage-scoped/i.test(all),
    "docs never mention the afk-safe/stage-scoped compatibility classes"
  );
  assert.ok(
    /never fall(?:s)? back|does not fall back/i.test(all),
    "docs never state an explicit invalid --review-skill never falls back to the built-in"
  );
});

// ---------------------------------------------------------------------------
// Read-only / no-fix / no-push trust boundary
// ---------------------------------------------------------------------------

test("docs document the read-only / no-fix / no-push trust boundary", () => {
  assert.ok(/read-only/i.test(all), "docs never say read-only");
  assert.ok(
    /no fix|never (?:edits?|writes?) (?:source|the repo)|does not edit|no source edits/i.test(
      all
    ),
    "docs never state the review stage never edits/fixes source"
  );
  assert.ok(
    /no push|never push(?:es)?|no network|no github credentials?/i.test(all),
    "docs never state the review stage cannot push or reach GitHub/network credentials"
  );
});

// ---------------------------------------------------------------------------
// Marker / idempotency + single-daemon limitation
// ---------------------------------------------------------------------------

test("docs document the idempotency markers and single-daemon-per-workspace limitation", () => {
  assertAllInclude(
    all,
    ["<!-- otto-review:", "<!-- otto-review-head:", "<!-- otto-review-input:"],
    "combined docs"
  );
  assert.ok(
    /idempotent/i.test(all),
    "docs never describe the summary comment / formal review as idempotent"
  );
  assert.ok(
    /single[- ]daemon|one .*--watch.* daemon|only (?:run|one) .*watch/i.test(
      all
    ),
    "docs never document the single-daemon-per-workspace limitation"
  );
});

// ---------------------------------------------------------------------------
// Self-approval permanent-error note
// ---------------------------------------------------------------------------

test("docs document GitHub's self-approval refusal as a permanent (non-retryable) error", () => {
  assert.ok(/self-approv/i.test(all), "docs never mention self-approval");
  assert.ok(
    /permanent|non-retryable|not retr(?:y|ied)/i.test(all),
    "docs never state the self-approval failure is permanent/non-retryable"
  );
});

// ---------------------------------------------------------------------------
// Evidence / input-artifact paths
// ---------------------------------------------------------------------------

test("docs document the durable evidence paths (diff, analysis, canonical review)", () => {
  assertAllInclude(
    all,
    [".otto/runs/", "pr.diff", "analysis.json", "review.md"],
    "combined docs"
  );
});

// ---------------------------------------------------------------------------
// ARCHITECTURE.md: module rows + local-exclude fact
// ---------------------------------------------------------------------------

test("docs/ARCHITECTURE.md adds P32 module rows to the module map", () => {
  assertAllInclude(
    architecture,
    [
      "pr-review.ts",
      "pr-review-input.ts",
      "pr-review-worktree.ts",
      "pr-review-state.ts",
      "pr-review-output.ts",
      "pr-review-publish.ts",
      "pr-review-watch.ts",
      "pr-review-diff.ts",
      "pr-review-skill.ts",
      "review-cli.ts",
      "review-main.ts",
    ],
    "docs/ARCHITECTURE.md module map"
  );
});

test("docs/ARCHITECTURE.md never universally claims permissionMode is bypassPermissions for ALL stages (the P32 read-only review stages use plan)", () => {
  // Guard against the pre-P32 universal claim regressing. A bare "always
  // bypassPermissions for all stages" contradicts the read-only review stages,
  // which run under permissionMode "plan". The assertion is deliberately narrow
  // so it does not misfire on the legitimate qualified sentences.
  assert.ok(
    !/always\s+`?bypassPermissions`?\s+for\s+all\s+stages/i.test(architecture),
    "docs/ARCHITECTURE.md still universally claims bypassPermissions for all stages"
  );
  assert.ok(
    !/`--permission-mode`\s+is\s+always\s+`?bypassPermissions`?/i.test(
      architecture
    ),
    "docs/ARCHITECTURE.md still claims --permission-mode is always bypassPermissions"
  );
  // Wherever the read-only review stages are described, `plan` must be named.
  assert.ok(
    /pr-review-lens[\s\S]*?permissionMode|permissionMode[\s\S]*?plan[\s\S]*?pr-review|pr-review-(?:lens|verify)[\s\S]*?`?plan`?|`?plan`?[\s\S]*?pr-review-(?:lens|verify)/i.test(
      architecture
    ),
    "docs/ARCHITECTURE.md never names permissionMode plan for the pr-review stages"
  );
});

test("docs record that target-repo ignoring uses local .git/info/exclude, never the tracked .gitignore", () => {
  assert.ok(
    /info\/exclude/.test(all),
    "docs never mention git's local info/exclude mechanism"
  );
  assert.ok(
    /tracked `?\.gitignore`? is never edited|never edit(?:s|ing)? (?:the )?(?:target(?:'s|s')? )?(?:repository'?s? )?tracked `?\.gitignore`?/i.test(
      all
    ),
    "docs never state the target repo's tracked .gitignore is never edited"
  );
});

// ---------------------------------------------------------------------------
// HARNESS_ROADMAP_PHASE6.md: P32 as an urgent parallel initiative
// ---------------------------------------------------------------------------

test("HARNESS_ROADMAP_PHASE6.md records P32 as an urgent PARALLEL initiative alongside P27-P31, not a renumbering", () => {
  assert.ok(roadmap.includes("P32"), "roadmap never mentions P32");
  assert.ok(
    /P27/.test(roadmap) && /P31/.test(roadmap),
    "roadmap no longer names P27..P31 alongside the new P32 entry"
  );
  assert.ok(
    /parallel/i.test(roadmap),
    "roadmap never frames P32 as a parallel initiative"
  );
  assert.ok(/urgent/i.test(roadmap), "roadmap never frames P32 as urgent");
  // Must not claim P27-P31 shipped (a targeted phrase check, not a broad
  // regex — the roadmap legitimately says things like "none of which have
  // shipped", which a naive negative match would misfire on).
  for (const bad of [
    "p27 has shipped",
    "p27 is shipped",
    "p27 shipped",
    "p28 has shipped",
    "p29 has shipped",
    "p30 has shipped",
    "p31 has shipped",
  ]) {
    assert.ok(
      !roadmap.toLowerCase().includes(bad),
      `roadmap must not claim "${bad}"`
    );
  }
});

test("HARNESS_ROADMAP_PHASE6.md P32 entry covers optional input, composite fingerprint identity, and uncompressed evidence", () => {
  const p32Start = roadmap.indexOf("P32");
  assert.notEqual(p32Start, -1, "roadmap has no P32 marker");
  const p32Section = roadmap.slice(p32Start);
  assert.ok(
    /issue|file|prompt/i.test(p32Section),
    "roadmap P32 entry never mentions optional issue/file/prompt input"
  );
  assert.ok(
    /composite/i.test(p32Section) && /fingerprint/i.test(p32Section),
    "roadmap P32 entry never mentions the composite fingerprint identity"
  );
  assert.ok(
    /uncompressed|never compress/i.test(p32Section),
    "roadmap P32 entry never mentions exact uncompressed input evidence"
  );
});

test("HARNESS_ROADMAP_PHASE6.md states P27 attested checks can enrich P32 later but do not block it", () => {
  assert.ok(
    /P27[^.]*(?:enrich|later)[^.]*P32|P32[^.]*P27[^.]*(?:enrich|later)|does not block/i.test(
      roadmap
    ),
    "roadmap never states P27 attested checks can enrich P32 later without blocking it"
  );
});

test("HARNESS_ROADMAP_PHASE6.md 'Last updated' is bumped to 2026-07-18", () => {
  assert.ok(
    roadmap.includes("Last updated: 2026-07-18"),
    "roadmap 'Last updated' line was not bumped to 2026-07-18"
  );
});

test("P32 source documents use the shipped OS-flock lease contract", () => {
  assert.doesNotMatch(p32Spec, /atomically claim the|atomic claims/);
  assert.doesNotMatch(p32Plan, /state, claims, evidence/);
  assert.match(p32Spec, /artifactPath: string \| null/);
  assert.doesNotMatch(p32Plan, /````ts/);
  assert.match(p32Plan, /```ts\nexport type PullRequestReviewOutputState/);
});
