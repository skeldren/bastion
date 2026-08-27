import assert from "node:assert/strict";
import test from "node:test";
import { nextReconnectDelayMs } from "./backoff.js";

test("bounds reconnect backoff at sixty seconds", () => {
  assert.equal(nextReconnectDelayMs(5_000), 10_000);
  assert.equal(nextReconnectDelayMs(40_000), 60_000);
  assert.equal(nextReconnectDelayMs(60_000), 60_000);
});
