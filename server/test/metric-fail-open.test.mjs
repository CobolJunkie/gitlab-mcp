import assert from "node:assert/strict";
import test from "node:test";

import { observeMetric } from "../src/observability.mjs";

test("metric sanitization failures remain non-fatal", () => {
  const attributes = {
    access: "read",
    outcome: "success",
    error_category: "none",
  };
  Object.defineProperty(attributes, "tool", {
    enumerable: true,
    get() {
      throw new Error("attribute unavailable");
    },
  });

  assert.doesNotThrow(() =>
    observeMetric({
      observer() {},
      metric: "gitlab_mcp.tool.calls",
      attributes,
    }),
  );
});
