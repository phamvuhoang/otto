import assert from "node:assert/strict";
import { test } from "node:test";

import { pageBounds } from "./pagination.mjs";

test("page 1 covers the first pageSize items", () => {
  assert.deepEqual(pageBounds(1, 10, 100), { start: 0, end: 10 });
});

test("clamps the final page to the total", () => {
  assert.deepEqual(pageBounds(3, 10, 25), { start: 20, end: 25 });
});
