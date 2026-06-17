// Documentation contract test for RELEASING.md (plan task 2 of issue #12).
// Issue #12's release-readiness initiative is "keep ... package contents,
// provenance, and rollback steps current." This pins RELEASING.md against the
// real packaging so the runbook can't silently rot:
//   - the documented package contents match each package.json `files:` array,
//   - the rollback runbook + provenance (SBOM/cosign) sections are present,
//   - every workflow file the cut/publish flow names actually exists on disk.
// Run via `pnpm test` (node --test). No build / network needed — reads
// RELEASING.md, the two package.json files, and .github/workflows/ directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releasing = readFileSync(join(root, "RELEASING.md"), "utf8");

const PACKAGES = [
  { pkg: "packages/core/package.json", npm: "@phamvuhoang/otto-core" },
  { pkg: "apps/cli/package.json", npm: "@phamvuhoang/otto" },
];

// Extract the backtick-quoted tokens after "ships:" on the bullet that names
// the given npm package. This is what RELEASING.md claims each tarball contains.
function documentedFiles(md, npm) {
  // Match the backtick-delimited exact name so `@phamvuhoang/otto` does not also
  // match the `@phamvuhoang/otto-core` line (substring trap).
  const line = md
    .split("\n")
    .find((l) => l.includes(`\`${npm}\``) && l.includes("ships:"));
  assert.ok(
    line,
    `RELEASING.md is missing a package-contents line for \`${npm}\` (expected "...ships: ...")`
  );
  const after = line.slice(line.indexOf("ships:") + "ships:".length);
  return new Set([...after.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

test("documented package contents match each package.json files array", () => {
  for (const { pkg, npm } of PACKAGES) {
    const { files } = JSON.parse(readFileSync(join(root, pkg), "utf8"));
    assert.ok(
      Array.isArray(files) && files.length > 0,
      `${pkg} has no files: array to pin`
    );
    assert.deepEqual(
      documentedFiles(releasing, npm),
      new Set(files),
      `RELEASING.md package contents for \`${npm}\` drifted from ${pkg} files: ${JSON.stringify(files)}`
    );
  }
});

test("rollback runbook + provenance (SBOM/cosign) sections are present", () => {
  assert.ok(
    /##\s*\d+\.\s*Rollback runbook/i.test(releasing),
    "RELEASING.md is missing the numbered Rollback runbook section"
  );
  assert.ok(
    releasing.includes("npm deprecate"),
    "rollback runbook must show the `npm deprecate` recovery command"
  );
  for (const token of ["SBOM", "cosign"]) {
    assert.ok(
      releasing.includes(token),
      `RELEASING.md must document ${token} provenance for published artifacts`
    );
  }
});

test("release-quality gate requires both machine verification and a human-readable quality report", () => {
  // Issue #19 Feature 3: a release-quality gate requiring BOTH machine
  // verification AND a human-readable quality report before merging/publishing
  // major changes. Pinned here so the gate can't silently drop out of the runbook.
  const heading = /###?\s*Release-quality gate/i;
  assert.ok(
    heading.test(releasing),
    "RELEASING.md is missing a `Release-quality gate` section"
  );
  // The gate's prose lives between its heading and the next heading.
  const start = releasing.search(heading);
  const rest = releasing.slice(start + 1);
  const next = rest.search(/\n#{2,3}\s/);
  const section = next === -1 ? rest : rest.slice(0, next);

  // Both halves of the gate must be named: machine verification AND the human report.
  assert.ok(
    /typecheck/.test(section) && /test/.test(section),
    "Release-quality gate must require machine verification (typecheck/tests)"
  );
  // The human-readable half must point at the real quality-report contract
  // fragment (drift-proof link — assert the file exists, like the workflow check).
  const contract = "packages/core/templates/quality-report.md";
  assert.ok(
    section.includes(contract),
    `Release-quality gate must link the quality report contract (${contract})`
  );
  assert.ok(
    existsSync(join(root, contract)),
    `Release-quality gate links \`${contract}\` but the file does not exist`
  );
  // The gate clears only on a human-accepted verdict — tests green is not enough.
  // Normalize whitespace so line-wrapping a verdict phrase doesn't break the pin.
  const flat = section.replace(/\s+/g, " ");
  assert.ok(
    /Accepted/.test(flat) && /Needs human review/.test(flat),
    "Release-quality gate must state which quality-report verdicts clear it (Accepted vs Needs human review)"
  );
});

test("every workflow file named in RELEASING.md exists in .github/workflows", () => {
  const named = new Set(
    [...releasing.matchAll(/[\w-]+\.yml/g)].map((m) => m[0])
  );
  assert.ok(
    named.has("publish-npm.yml"),
    "RELEASING.md must name the real publish workflow (publish-npm.yml)"
  );
  for (const wf of named) {
    assert.ok(
      existsSync(join(root, ".github", "workflows", wf)),
      `RELEASING.md names \`${wf}\` but .github/workflows/${wf} does not exist (workflow rename/drift)`
    );
  }
});
