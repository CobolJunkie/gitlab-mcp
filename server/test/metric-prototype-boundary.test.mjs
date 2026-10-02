import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMetricMeasurement } from "../src/metric-contract.mjs";

test("metric lookup rejects prototype-chain property names", () => {
  for (const metric of ["__proto__", "constructor", "toString"]) {
    assert.equal(
      sanitizeMetricMeasurement({ metric, value: 1, attributes: {} }),
      undefined,
    );
  }
});

test("required metric attributes must be own properties", () => {
  const inherited = Object.create({
    cache: "capability",
    result: "hit",
  });
  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      attributes: inherited,
    }),
    undefined,
  );
});
