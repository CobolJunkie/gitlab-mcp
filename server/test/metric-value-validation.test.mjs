import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMetricMeasurement } from "../src/metric-contract.mjs";

test("metric values require finite numbers and only up/down counters accept negatives", () => {
  const counterAttributes = {
    cache: "capability",
    result: "hit",
  };

  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      value: "1",
      attributes: counterAttributes,
    }),
    undefined,
  );
  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      value: -1,
      attributes: counterAttributes,
    }),
    undefined,
  );
  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      value: Number.NaN,
      attributes: counterAttributes,
    }),
    undefined,
  );

  const upDown = sanitizeMetricMeasurement({
    metric: "gitlab_mcp.tool.active",
    value: -1,
    attributes: { tool: "unknown", access: "read" },
  });
  assert.equal(upDown?.value, -1);

  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.capacity",
      value: -1,
      attributes: { cache: "capability" },
    }),
    undefined,
  );

  const histogram = sanitizeMetricMeasurement({
    metric: "gitlab_mcp.cache.capacity",
    value: 256,
    attributes: { cache: "capability" },
  });
  assert.equal(histogram?.value, 256);
});
