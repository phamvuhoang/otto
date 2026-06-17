// Documentation contract test for the sample quality reports (Feature 2 of
// issue #19: "Sample verification transcripts"). The roadmap wants users to see
// what GOOD quality-report output looks like, so docs/quality-report-samples.md
// ships a few realistic, filled-in reports. This pins those samples against the
// REAL contract template (packages/core/templates/quality-report.md) so that a
// change to the contract's sections or verdict vocabulary forces the samples to
// be updated instead of silently going stale:
//   - the six contract section headings   ← parsed from quality-report.md
//   - the four-value verdict vocabulary    ← parsed from quality-report.md
//   - the real run modes                   ← parsed from quality-report.md
// Run via `pnpm test` (node --test). No build / network needed — reads the doc
// and the template directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = readFileSync(
  join(root, "packages", "core", "templates", "quality-report.md"),
  "utf8"
);
const samplesPath = join(root, "docs", "quality-report-samples.md");
const samples = readFileSync(samplesPath, "utf8");

// Source of truth #1: the contract's `## ` section headings. The template's only
// `## ` lines are the six contract sections (inside the ```markdown fence).
const CONTRACT_SECTIONS = [...contract.matchAll(/^## (.+)$/gm)].map((m) =>
  m[1].trim()
);

// Source of truth #2: the verdict vocabulary — the bolded values on the
// "One of — **A** · **B** · ..." line in the contract.
const verdictLine = contract
  .split("\n")
  .find((l) => l.includes("One of") && l.includes("**"));
const VERDICTS = verdictLine
  ? [...verdictLine.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim())
  : [];

// Source of truth #3: the run modes — the `Mode: <a | b | ...>` placeholder.
// Parse ONLY the `<...>` placeholder so the "Mode" label can't leak a junk token.
const modeLine = contract.split("\n").find((l) => l.includes("Mode:"));
const modeMatch = modeLine ? modeLine.match(/<([^>]+)>/) : null;
const MODES = modeMatch ? modeMatch[1].split("|").map((s) => s.trim()) : [];

// Split the doc into individual sample reports on the `# Otto quality report`
// title (the same H1 the contract emits).
function sampleReports(md) {
  const parts = md.split(/^# Otto quality report\s*$/m);
  // parts[0] is the doc's preamble (before the first report); drop it.
  return parts.slice(1);
}

test("contract parse sanity — the test's sources of truth resolved", () => {
  assert.deepEqual(
    CONTRACT_SECTIONS,
    [
      "Verdict",
      "Task Source",
      "What Changed",
      "Evidence",
      "Human Acceptance Checklist",
      "Gaps And Follow-Ups",
    ],
    "quality-report.md contract sections drifted — update the samples + this test"
  );
  assert.deepEqual(
    VERDICTS,
    ["Accepted", "Accepted with follow-ups", "Needs human review", "Rejected"],
    "verdict vocabulary drifted from quality-report.md"
  );
  assert.ok(
    MODES.includes("ghafk") && MODES.includes("verify"),
    `failed to parse run modes from quality-report.md: ${MODES}`
  );
});

test("samples doc exists with a few realistic reports", () => {
  const reports = sampleReports(samples);
  assert.ok(
    reports.length >= 3,
    `docs/quality-report-samples.md must contain at least 3 sample reports (found ${reports.length})`
  );
});

test("every sample carries all six contract sections", () => {
  for (const [i, report] of sampleReports(samples).entries()) {
    for (const section of CONTRACT_SECTIONS) {
      assert.ok(
        report.includes(`## ${section}`),
        `sample report #${i + 1} is missing the "## ${section}" contract section`
      );
    }
  }
});

test("every sample states a real verdict and a real mode", () => {
  for (const [i, report] of sampleReports(samples).entries()) {
    assert.ok(
      VERDICTS.some((v) => report.includes(v)),
      `sample report #${i + 1} must state one of the contract verdicts: ${VERDICTS.join(" / ")}`
    );
    assert.ok(
      MODES.some((m) => new RegExp(`Mode:.*\\b${m}\\b`).test(report)),
      `sample report #${i + 1} must name a real run mode (${MODES.join(" / ")}) on its Mode: line`
    );
  }
});

test("samples span both issue providers (GitHub + Linear parity)", () => {
  // The roadmap's #3 key risk is provider drift; the samples must show the same
  // report shape for a GitHub and a Linear run so users see the parity.
  const reports = sampleReports(samples);
  assert.ok(
    reports.some((r) => /Mode:.*\bghafk\b/.test(r)),
    "samples must include a GitHub (ghafk) run"
  );
  assert.ok(
    reports.some((r) => /Mode:.*\blinear-afk\b/.test(r)),
    "samples must include a Linear (linear-afk) run"
  );
});

test("samples demonstrate the 'Needs human review' default verdict", () => {
  // The contract defaults to Needs human review when evidence is thin; at least
  // one sample must model that honest verdict, not only Accepted ones.
  const reports = sampleReports(samples);
  assert.ok(
    reports.some((r) => /## Verdict[\s\S]*Needs human review/.test(r)),
    "at least one sample must show a 'Needs human review' verdict"
  );
});

test("README documentation table links the samples doc", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes("docs/quality-report-samples.md"),
    "README documentation table must link docs/quality-report-samples.md"
  );
});
