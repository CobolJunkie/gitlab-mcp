import assert from "node:assert/strict";
import test from "node:test";

import { failure } from "../src/tools/responses.mjs";

test("generic failures preserve primitive thrown values", () => {
  const response = failure("legacy failure");
  assert.deepEqual(response.structuredContent.result, {
    error: "Error",
    message: "legacy failure",
  });
});

test("generic failures remain safe when error metadata access throws", () => {
  const error = {};
  Object.defineProperties(error, {
    name: {
      get() {
        throw new Error("name getter failed");
      },
    },
    message: {
      get() {
        throw new Error("message getter failed");
      },
    },
  });
  const response = failure(error);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.result.error, "Error");
  assert.equal(typeof response.structuredContent.result.message, "string");
});
