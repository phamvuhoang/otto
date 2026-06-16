// Documentation contract test for the Linear mode (otto-linear-afk) docs
// (plan task 10 of issue #14). Pins that docs/CLI.md documents the Linear loop
// — its bins, gate/single-issue stage names, the bundled `otto-linear` helper +
// `otto-linear-auth` subcommands, and the Linear selection/completion env vars
// — and that the stage and bin names it cites match SOURCE. A rename in
// stages.ts / apps/cli/package.json that isn't mirrored in the docs fails here
// instead of silently drifting. Run via `pnpm test` (node --test); no build /
// network needed — reads the markdown + source directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const cli = read("docs", "CLI.md");
const readme = read("README.md");
const stagesSrc = read("packages", "core", "src", "stages.ts");
const cliPkg = JSON.parse(read("apps", "cli", "package.json"));

// Read a stage's `name:` string straight from STAGES so a rename in stages.ts
// that the docs don't mirror fails this test.
function stageName(key) {
  const m = stagesSrc.match(
    new RegExp(`${key}:\\s*\\{[\\s\\S]*?name:\\s*"([^"]+)"`)
  );
  assert.ok(m, `could not find STAGES.${key} name in stages.ts`);
  return m[1];
}

test("CLI.md documents the otto-linear-afk mode and its stage names", () => {
  assert.ok(
    cli.includes("otto-linear-afk"),
    "docs/CLI.md never mentions otto-linear-afk"
  );
  for (const key of ["linearImplementer", "linearIssueImplementer"]) {
    const name = stageName(key);
    assert.ok(
      cli.includes(name),
      `docs/CLI.md is missing the \`${name}\` stage name`
    );
  }
});

test("CLI.md documents every otto-linear* bin the CLI ships", () => {
  const bins = Object.keys(cliPkg.bin).filter((b) => b.startsWith("otto-linear"));
  assert.ok(
    bins.length >= 3,
    `expected ≥3 otto-linear* bins in apps/cli/package.json, found ${bins.length}`
  );
  for (const bin of bins) {
    assert.ok(cli.includes(bin), `docs/CLI.md is missing the \`${bin}\` bin`);
  }
});

test("CLI.md documents the otto-linear helper + otto-linear-auth subcommands", () => {
  for (const sub of ["list", "dump", "view", "comment", "done"]) {
    assert.ok(
      new RegExp(`otto-linear ${sub}\\b`).test(cli),
      `docs/CLI.md is missing the \`otto-linear ${sub}\` helper subcommand`
    );
  }
  for (const sub of ["login", "status", "logout"]) {
    assert.ok(
      new RegExp(`otto-linear-auth ${sub}\\b`).test(cli),
      `docs/CLI.md is missing the \`otto-linear-auth ${sub}\` subcommand`
    );
  }
});

test("CLI.md documents the Linear auth/selection/completion env vars", () => {
  for (const env of [
    "OTTO_LINEAR_API_KEY",
    "OTTO_LINEAR_LABEL",
    "OTTO_LINEAR_TEAM",
    "OTTO_LINEAR_DONE_STATE",
  ]) {
    assert.ok(cli.includes(env), `docs/CLI.md is missing the ${env} env var`);
  }
});

test("README lists otto-linear-afk among the modes", () => {
  assert.ok(
    readme.includes("otto-linear-afk"),
    "README.md never mentions otto-linear-afk"
  );
});
