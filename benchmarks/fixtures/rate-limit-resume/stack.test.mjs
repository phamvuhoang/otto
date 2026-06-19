import assert from "node:assert/strict";
import { test } from "node:test";

import { Stack } from "./stack.mjs";

test("peek returns the most recently pushed item", () => {
  const s = new Stack();
  s.push("a");
  s.push("b");
  assert.equal(s.peek(), "b");
  assert.equal(s.size, 2);
});
