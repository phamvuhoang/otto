// Deterministic post-run check for the fanout-overlap fixture (P25 Task 8).
// Reads the latest run's manifest.json (written under .otto/runs/<id>/ by
// every otto-afk run — see run-report.ts) and asserts the fan-out evidence
// (P25 Task 4's `manifest.fanout.contributions`) shows exactly one task
// landed and one deferred with a recorded reason, matching what this
// fixture's overlapping-fileScope tasks.json is designed to exercise. Exit 0
// = pass, matching the `command` contract in benchmarks/suite.json's checks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const runsDir = join(".otto", "runs");

if (!existsSync(runsDir)) {
  console.error(`fanout-contributions: no ${runsDir} — did a run happen?`);
  process.exit(1);
}

const runIds = readdirSync(runsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((id) => existsSync(join(runsDir, id, "manifest.json")))
  .sort();

const latest = runIds[runIds.length - 1];
if (!latest) {
  console.error(
    `fanout-contributions: no run with a manifest.json under ${runsDir}`
  );
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(join(runsDir, latest, "manifest.json"), "utf8")
);
const contributions = manifest.fanout?.contributions ?? [];

const landed = contributions.filter((c) => c.status === "landed");
const deferred = contributions.filter(
  (c) =>
    c.status === "deferred" &&
    typeof c.reason === "string" &&
    c.reason.length > 0
);

if (landed.length === 1 && deferred.length === 1) {
  process.exit(0);
}

console.error(
  "fanout-contributions: expected exactly 1 landed + 1 deferred (with a reason), got:",
  JSON.stringify(contributions, null, 2)
);
process.exit(1);
