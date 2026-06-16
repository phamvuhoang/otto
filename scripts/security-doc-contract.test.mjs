// Documentation contract test for SECURITY.md's threat model (plan task 3 of
// issue #12). Issue #12's security initiative is "make sandbox limits,
// bypassPermissions, trusted-input assumptions, and OTTO_RUNNER=host tradeoffs
// explicit." This pins SECURITY.md's three threat-model invariants against the
// REAL source defaults so a default change forces a doc edit instead of leaving
// the threat model silently stale:
//   - the bypassPermissions run line   ← stages.ts `permissionMode`
//   - the sandbox-vs-OTTO_RUNNER=host blast radius ← runner.ts `resolveRunner`
//   - the static-shell-tag invariant   ← render.ts (execSync of tag bodies)
// Run via `pnpm test` (node --test). No build / network needed — reads
// SECURITY.md and parses stages.ts / runner.ts / render.ts directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const security = readFileSync(join(root, "SECURITY.md"), "utf8");
const src = (rel) =>
  readFileSync(join(root, "packages", "core", "src", rel), "utf8");
const stagesSrc = src("stages.ts");
const runnerSrc = src("runner.ts");
const renderSrc = src("render.ts");

// Slice from `## <heading prefix>` to the next top-level `## ` heading. The prefix
// need only be unique; SECURITY.md headings carry em-dashes/parens we don't repeat.
function section(md, headingPrefix) {
  const start = md.indexOf(`## ${headingPrefix}`);
  assert.notEqual(
    start,
    -1,
    `SECURITY.md is missing a "## ${headingPrefix}..." section`
  );
  const rest = md.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("threat model pins the real bypassPermissions permission mode", () => {
  // Source of truth: every stage's permissionMode. They are uniform today; the
  // doc claims that exact value, so a stage that drops/changes the mode breaks
  // this test and forces SECURITY.md to be re-justified.
  const modes = new Set(
    [...stagesSrc.matchAll(/permissionMode:\s*"([^"]+)"/g)].map((m) => m[1])
  );
  assert.ok(modes.size > 0, "parsed no permissionMode from stages.ts");
  assert.deepEqual(
    modes,
    new Set(["bypassPermissions"]),
    `stages.ts permissionMode drifted from "bypassPermissions": ${[...modes]}`
  );

  const threat = section(security, "Threat model");
  for (const mode of modes) {
    assert.ok(
      threat.includes(mode),
      `SECURITY.md threat model must name the real permission mode "${mode}"`
    );
  }
  assert.ok(
    threat.includes("--permission-mode bypassPermissions"),
    "threat model must show the real `--permission-mode bypassPermissions` run line"
  );
});

test("threat model pins the sandbox-vs-host blast radius against resolveRunner", () => {
  // resolveRunner: `host` → host, anything else → the default. Parse both tokens
  // from source so the doc can't claim a default the code no longer uses.
  const m = runnerSrc.match(/===\s*"host"\s*\?\s*"host"\s*:\s*"([^"]+)"/);
  assert.ok(m, "could not parse resolveRunner's default from runner.ts");
  const defaultRunner = m[1];
  assert.equal(
    defaultRunner,
    "sandbox",
    `runner default drifted from "sandbox" to "${defaultRunner}"`
  );

  const threat = section(security, "Threat model");
  assert.ok(
    threat.includes(`OTTO_RUNNER=${defaultRunner}`),
    `threat model must name the real default runner OTTO_RUNNER=${defaultRunner}`
  );
  assert.ok(
    threat.includes("OTTO_RUNNER=host"),
    "threat model must document the OTTO_RUNNER=host (unsandboxed) tradeoff"
  );
  assert.ok(
    /unsandboxed/i.test(threat),
    "threat model must state that OTTO_RUNNER=host runs unsandboxed"
  );
});

test("template-authoring section pins the static-shell-tag invariant against render.ts", () => {
  // render.ts executes tag command bodies on the host shell (execSync) and
  // substitutes {{ INPUTS }} last. SECURITY.md must keep documenting that exact
  // invariant; if render.ts stopped shelling tags or moved the INPUTS pass, the
  // doc would be describing code that no longer exists.
  assert.ok(
    renderSrc.includes("execSync"),
    "render.ts no longer uses execSync — re-check the host-shell threat model"
  );
  assert.ok(
    /SECURITY INVARIANT[\s\S]*INPUTS[\s\S]*substituted LAST/i.test(renderSrc),
    "render.ts must keep the INPUTS-substituted-last SECURITY INVARIANT comment"
  );

  const authoring = section(security, "Template authoring");
  assert.ok(
    authoring.includes("render.ts"),
    "template-authoring section must point at render.ts"
  );
  for (const tag of ["!`cmd`", "!?`cmd`", "@spill"]) {
    assert.ok(
      authoring.includes(tag),
      `template-authoring section must name the host-shell tag ${tag}`
    );
  }
  assert.ok(
    /static/i.test(authoring) && /substituted last/i.test(authoring),
    "template-authoring section must state templates use static command bodies and {{ INPUTS }} is substituted last"
  );
});
