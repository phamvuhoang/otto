import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPrice } from "./format.mjs";

test("formatPrice renders integer cents as a dollar string", () => {
  assert.equal(formatPrice(150), "$1.50");
  assert.equal(formatPrice(500), "$5.00");
});
