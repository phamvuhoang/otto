import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize } from "./report.mjs";
import { humanSize } from "./units.mjs";

test("humanSize renders byte counts in the largest fitting unit", () => {
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1024 * 1024 * 3), "3.0 MB");
});

test("summarize uses human-readable sizes", () => {
  const out = summarize([
    { name: "a.txt", bytes: 1024 },
    { name: "b.bin", bytes: 1536 },
  ]);
  assert.equal(out, "a.txt: 1.0 KB\nb.bin: 1.5 KB");
});
