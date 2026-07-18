import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatch } from "./registry.mjs";

test("dispatch resolves the refund handler by its dynamic string key", () => {
  const result = dispatch("refund", { orderId: "o1", amount: 42 });
  assert.deepEqual(result, { orderId: "o1", refunded: 42 });
});

test("existing dynamically-dispatched handlers still resolve", () => {
  assert.deepEqual(dispatch("order", { orderId: "o2" }), {
    orderId: "o2",
    status: "placed",
  });
  assert.deepEqual(dispatch("payment", { orderId: "o3", amount: 10 }), {
    orderId: "o3",
    charged: 10,
  });
});
