import assert from "node:assert/strict";
import { test } from "node:test";

import { scheduleAlertRetry } from "./alerts.mjs";
import { computeBackoffMs } from "./policy.mjs";

test("policy.mjs exports the renamed backoff function", () => {
  assert.equal(computeBackoffMs(1), 200);
  assert.equal(computeBackoffMs(3), 600);
});

test("scheduleAlertRetry reuses the shared backoff policy instead of duplicating it", () => {
  assert.equal(scheduleAlertRetry(3).delayMs, computeBackoffMs(3));
});
