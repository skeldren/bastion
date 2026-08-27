import assert from "node:assert/strict";
import test from "node:test";
import { createJobResult } from "./job-result.js";

test("successful connection results omit failure fields", () => {
  assert.deepEqual(createJobResult(true, undefined, "connection_unavailable"), {
    success: true,
  });
});

test("successful player results include only the count", () => {
  assert.deepEqual(createJobResult(true, 17, "connection_unavailable"), {
    success: true,
    players: 17,
  });
});

test("failed results include only the safe error code", () => {
  assert.deepEqual(createJobResult(false, undefined, "timeout"), {
    success: false,
    errorCode: "timeout",
  });
});
