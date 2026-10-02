import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceMetricCardinalityBudget,
  GITLAB_MCP_METRIC_CONTRACT,
  registerMetricIdentifier,
  resetMetricContractStateForTest,
  sanitizeMetricMeasurement,
  validateMetricContract,
} from "../src/metric-contract.mjs";
import { GitLabClient } from "../src/gitlab-client.mjs";
import { createToolRegistrar } from "../src/tools/register.mjs";

function fakeServer() {
  const registrations = new Map();
  return {
    registrations,
    registerTool(name, config, handler) {
      registrations.set(name, { config, handler });
    },
  };
}

function metricEvent(events, metric) {
  return events.find((event) => event.metric === metric);
}

test("closed-enum metrics retain every legal series within their declared budget", () => {
  resetMetricContractStateForTest();
  for (const cache of ["token_validation", "capability"]) {
    for (const result of ["hit", "miss"]) {
      const measurement = sanitizeMetricMeasurement({
        metric: "gitlab_mcp.cache.requests",
        attributes: { cache, result },
      });
      assert.deepEqual(
        enforceMetricCardinalityBudget(measurement),
        measurement.attributes,
      );
    }
  }
  resetMetricContractStateForTest();
});

test("contract validation rejects a closed-enum budget that cannot represent its legal series", () => {
  assert.deepEqual(
    validateMetricContract({
      schemaVersion: 1,
      metrics: {
        "gitlab_mcp.fixture": {
          type: "counter",
          unit: "{event}",
          description: "Closed-enum cardinality validation fixture.",
          privacy: "non-sensitive",
          stability: "experimental",
          cardinalityBudget: 1,
          attributes: { outcome: { values: ["success", "error"] } },
          requiredAttributes: ["outcome"],
        },
      },
    }),
    [
      "gitlab_mcp.fixture: cardinality budget 1 cannot represent all 2 closed-enum series.",
    ],
  );
});

test("published metric contract is recursively immutable", () => {
  const definition =
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.tool.calls"];
  assert.equal(Object.isFrozen(GITLAB_MCP_METRIC_CONTRACT), true);
  assert.equal(Object.isFrozen(GITLAB_MCP_METRIC_CONTRACT.metrics), true);
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.attributes), true);
  assert.equal(Object.isFrozen(definition.attributes.access.values), true);
});

test("identifier overflow preserves required closed dimensions", () => {
  resetMetricContractStateForTest();
  const definition =
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.tool.active"];
  let attributes;
  for (let index = 0; index < definition.cardinalityBudget; index += 1) {
    const tool = `tool_${index}`;
    assert.equal(registerMetricIdentifier("tool", tool), true);
    const measurement = sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.active",
      attributes: { tool, access: "read" },
    });
    attributes = enforceMetricCardinalityBudget(measurement);
  }
  assert.deepEqual(attributes, { tool: "unknown", access: "read" });
  resetMetricContractStateForTest();
});

test("authentication fallback transport failure has no stale HTTP status or response size", async () => {
  const events = [];
  let calls = 0;
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example",
    token: "glpat-review-regression",
    observabilityObserver: (event) => events.push(event),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 401 });
      }
      throw new Error("connection reset");
    },
  });

  await assert.rejects(client.request("/projects"), /GitLab request failed/);
  assert.equal(calls, 2);
  assert.deepEqual(
    metricEvent(events, "gitlab_mcp.gitlab.request.duration").attributes,
    {
      method: "GET",
      outcome: "error",
      status_class: "none",
      response_type: "json",
    },
  );
  assert.equal(
    metricEvent(events, "gitlab_mcp.gitlab.response.size"),
    undefined,
  );
  assert.deepEqual(
    metricEvent(events, "gitlab_mcp.gitlab.retries").attributes,
    {
      reason: "authentication_fallback",
      method: "GET",
    },
  );
});

test("successful responses prefer declared content length for response size", async () => {
  const events = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example",
    token: "token",
    observabilityObserver: (event) => events.push(event),
    fetchImpl: async () =>
      new Response("decoded-response-body", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "7",
        },
      }),
  });

  const response = await client.request("/projects", { responseType: "text" });
  assert.equal(response.data, "decoded-response-body");
  const size = metricEvent(events, "gitlab_mcp.gitlab.response.size");
  assert.equal(size.value, 7);
  assert.deepEqual(size.attributes, {
    method: "GET",
    outcome: "success",
    response_type: "text",
  });
});

test("oversized chunked responses report bytes observed before bounded failure", async () => {
  const events = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(10));
      controller.close();
    },
  });
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example",
    token: "token",
    observabilityObserver: (event) => events.push(event),
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  await assert.rejects(
    client.request("/projects", { maxBytes: 8 }),
    /exceeds the 8-byte safety limit/,
  );
  const size = metricEvent(events, "gitlab_mcp.gitlab.response.size");
  assert.equal(size.value, 16);
  assert.deepEqual(size.attributes, {
    method: "GET",
    outcome: "error",
    response_type: "json",
  });
});

test("a real GitLab body timeout reaches the tool metric as timeout and keeps partial size", async () => {
  const events = [];
  const server = fakeServer();
  const { tool } = createToolRegistrar({
    server,
    observabilityObserver: (event) => events.push(event),
    clientFactory: (_extra, { observabilityObserver }) =>
      new GitLabClient({
        baseUrl: "https://gitlab.example",
        token: "token",
        timeoutMs: 25,
        observabilityObserver,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("part"));
              },
            }),
            { status: 200 },
          ),
      }),
  });

  tool("get_project", { annotations: { readOnlyHint: true } }, async (client) =>
    client.request("/projects/1"),
  );
  const response = await server.registrations
    .get("get_project")
    .handler({}, {});

  assert.equal(response.isError, true);
  assert.equal(
    metricEvent(events, "gitlab_mcp.tool.calls").attributes.error_category,
    "timeout",
  );
  assert.equal(
    metricEvent(events, "gitlab_mcp.tool.calls").attributes.tool,
    "get_project",
  );
  assert.deepEqual(
    metricEvent(events, "gitlab_mcp.gitlab.request.duration").attributes,
    {
      method: "GET",
      outcome: "error",
      status_class: "2xx",
      response_type: "json",
    },
  );
  assert.equal(metricEvent(events, "gitlab_mcp.gitlab.response.size").value, 4);
});
