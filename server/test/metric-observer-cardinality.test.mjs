import assert from "node:assert/strict";
import test from "node:test";

import {
  GITLAB_MCP_METRIC_CONTRACT,
  registerMetricIdentifier,
  resetMetricContractStateForTest,
} from "../src/metric-contract.mjs";
import { observeMetric } from "../src/observability.mjs";

test("metric observer events honor the contract cardinality budget", () => {
  resetMetricContractStateForTest();
  const events = [];
  const definition =
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.tool.calls"];

  for (let index = 0; index < definition.cardinalityBudget; index += 1) {
    const tool = `observer_tool_${index}`;
    assert.equal(registerMetricIdentifier("tool", tool), true);
    observeMetric({
      observer: (event) => events.push(event),
      metric: "gitlab_mcp.tool.calls",
      attributes: {
        tool,
        access: "read",
        outcome: "success",
        error_category: "none",
      },
    });
  }

  assert.equal(events.length, definition.cardinalityBudget);
  assert.equal(events.at(-1).attributes.tool, "unknown");
  resetMetricContractStateForTest();
});
