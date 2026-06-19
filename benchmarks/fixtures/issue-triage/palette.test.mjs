import assert from "node:assert/strict";
import { test } from "node:test";

import { colour } from "./palette.mjs";

test("returns known colours and null for unknown", () => {
  assert.equal(colour("red"), "#ff0000");
  assert.equal(colour("unknown"), null);
});

test("includes the teal colour requested by the intake issue", () => {
  assert.equal(colour("teal"), "#008080");
});
