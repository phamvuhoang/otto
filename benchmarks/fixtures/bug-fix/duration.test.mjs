import assert from "node:assert/strict";
import { test } from "node:test";

import { totalMinutes } from "./duration.mjs";

test("converts hours and minutes to total minutes", () => {
  assert.equal(totalMinutes("45m"), 45);
  assert.equal(totalMinutes("2h"), 120);
  assert.equal(totalMinutes("1h30m"), 90);
});
