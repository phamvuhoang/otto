// Wiring contract test for the `otto-memory` bin (issue #42 P3, slice 5). The
// audit command is only useful if the bin is actually shipped: declared in the
// CLI package's `bin` map, present on disk with a node shebang, and delegating to
// the core `runMemory` entry point. This pins all three so a half-wired bin (e.g.
// a package.json entry with no file, or a file that imports the wrong symbol)
// fails here rather than at install time. Run via `pnpm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPkg = JSON.parse(
  readFileSync(join(root, "apps", "cli", "package.json"), "utf8")
);

test("package.json declares the otto-memory bin", () => {
  assert.equal(cliPkg.bin["otto-memory"], "./bin/otto-memory.js");
});

test("the bin file exists, has a node shebang, and calls runMemory", () => {
  const bin = readFileSync(
    join(root, "apps", "cli", "bin", "otto-memory.js"),
    "utf8"
  );
  assert.match(bin, /^#!\/usr\/bin\/env node/, "missing node shebang");
  assert.match(
    bin,
    /import \{ runMemory \} from "@phamvuhoang\/otto-core"/,
    "bin must import runMemory from the core package"
  );
  assert.match(bin, /runMemory\(process\.argv\.slice\(2\)\)/);
});

test("core re-exports runMemory + formatAuditReport", () => {
  const index = readFileSync(
    join(root, "packages", "core", "src", "index.ts"),
    "utf8"
  );
  assert.match(index, /\brunMemory\b/);
  assert.match(index, /\bformatAuditReport\b/);
});
