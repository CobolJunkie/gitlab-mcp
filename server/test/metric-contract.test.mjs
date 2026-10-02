import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  enforceMetricCardinalityBudget,
  GITLAB_MCP_METRIC_CONTRACT,
  GITLAB_MCP_METRIC_NAMES,
  recordMetricMeasurement,
  registerMetricIdentifier,
  resetMetricContractStateForTest,
  sanitizeMetricMeasurement,
  validateMetricContract,
} from "../src/metric-contract.mjs";
import { GitLabClient } from "../src/gitlab-client.mjs";
import { observeMetric } from "../src/observability.mjs";
import { success } from "../src/tools/responses.mjs";

const SERVER_SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

test("Metric Contract v1 is complete and machine-valid", () => {
  assert.deepEqual(validateMetricContract(), []);
  assert.equal(GITLAB_MCP_METRIC_CONTRACT.schemaVersion, 1);
  assert.equal(GITLAB_MCP_METRIC_NAMES.length, 16);
  for (const definition of Object.values(GITLAB_MCP_METRIC_CONTRACT.metrics)) {
    assert.ok(definition.cardinalityBudget > 0);
    assert.equal(definition.privacy, "non-sensitive");
    assert.deepEqual(
      new Set(definition.requiredAttributes),
      new Set(Object.keys(definition.attributes || {})),
    );
  }
});

test("every custom metric literal emitted by server source is contract-declared", async () => {
  const declared = new Set(GITLAB_MCP_METRIC_NAMES);
  const emitted = new Set();
  for (const path of await sourceFiles(SERVER_SOURCE_ROOT)) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(
      /metric:\s*["'](gitlab_mcp\.[^"']+)/gu,
    )) {
      emitted.add(match[1]);
    }
  }
  assert.ok(emitted.size > 0);
  assert.deepEqual(
    [...emitted].filter((name) => !declared.has(name)),
    [],
  );
});

test("metric sanitizer drops undeclared and forbidden dimensions", () => {
  const measurement = sanitizeMetricMeasurement({
    metric: "gitlab_mcp.gitlab.request.duration",
    value: 0.25,
    attributes: {
      method: "GET",
      outcome: "success",
      status_class: "2xx",
      response_type: "json",
      project: "secret/project",
      path: "/projects/123/issues/456",
      token: "secret-token",
      commit_sha: "deadbeef",
    },
  });
  assert.deepEqual(measurement.attributes, {
    method: "GET",
    outcome: "success",
    status_class: "2xx",
    response_type: "json",
  });
});

test("metric sanitizer permits only registered identifier values", () => {
  resetMetricContractStateForTest();
  assert.equal(registerMetricIdentifier("tool", "get_issue"), true);
  assert.equal(registerMetricIdentifier("project", "private_project"), false);

  const valid = sanitizeMetricMeasurement({
    metric: "gitlab_mcp.tool.calls",
    attributes: {
      tool: "get_issue",
      access: "read",
      outcome: "success",
      error_category: "none",
    },
  });
  assert.equal(valid.attributes.tool, "get_issue");

  for (const tool of [
    "private/project with spaces",
    "alice",
    "12345",
    "main",
    "deadbeef",
  ]) {
    const invalid = sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.calls",
      attributes: {
        tool,
        access: "read",
        outcome: "success",
        error_category: "none",
      },
    });
    assert.equal(invalid.attributes.tool, "unknown");
  }

  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.calls",
      value: Number.POSITIVE_INFINITY,
    }),
    undefined,
  );
  resetMetricContractStateForTest();
});

test("unknown metrics, missing required attributes, and invalid enum values cannot be emitted", () => {
  assert.equal(
    sanitizeMetricMeasurement({ metric: "gitlab_mcp.not_declared", value: 1 }),
    undefined,
  );
  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      attributes: { cache: "user-controlled", result: "hit" },
    }),
    undefined,
  );
  assert.equal(
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.cache.requests",
      attributes: { cache: "capability" },
    }),
    undefined,
  );
});

test("cardinality budget collapses excess identifiers while preserving required dimensions", () => {
  resetMetricContractStateForTest();
  const definition =
    GITLAB_MCP_METRIC_CONTRACT.metrics["gitlab_mcp.tool.calls"];
  let attributes;
  for (let index = 0; index < definition.cardinalityBudget; index += 1) {
    const tool = `tool_${index}`;
    assert.equal(registerMetricIdentifier("tool", tool), true);
    const measurement = sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.calls",
      attributes: {
        tool,
        access: "read",
        outcome: "success",
        error_category: "none",
      },
    });
    attributes = enforceMetricCardinalityBudget(measurement);
  }
  assert.deepEqual(attributes, {
    tool: "unknown",
    access: "read",
    outcome: "success",
    error_category: "none",
  });
  resetMetricContractStateForTest();
});

test("cardinality enforcement rejects unknown metrics and reuses known series", () => {
  resetMetricContractStateForTest();
  assert.equal(
    enforceMetricCardinalityBudget({ metric: "gitlab_mcp.not_declared" }),
    undefined,
  );
  const measurement = sanitizeMetricMeasurement({
    metric: "gitlab_mcp.cache.requests",
    attributes: { cache: "capability", result: "hit" },
  });
  assert.deepEqual(
    enforceMetricCardinalityBudget(measurement),
    measurement.attributes,
  );
  assert.deepEqual(
    enforceMetricCardinalityBudget(measurement),
    measurement.attributes,
  );
  resetMetricContractStateForTest();
});

test("metric recorder supports every declared instrument family and ignores unknown metrics", () => {
  resetMetricContractStateForTest();
  assert.equal(registerMetricIdentifier("tool", "get_issue"), true);
  assert.doesNotThrow(() => recordMetricMeasurement(undefined));
  for (const measurement of [
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.calls",
      attributes: {
        tool: "get_issue",
        access: "read",
        outcome: "success",
        error_category: "none",
      },
    }),
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.active",
      attributes: { tool: "get_issue", access: "read" },
    }),
    sanitizeMetricMeasurement({
      metric: "gitlab_mcp.tool.handler.duration",
      value: 0.01,
      attributes: { tool: "get_issue", access: "read", outcome: "success" },
    }),
  ]) {
    assert.doesNotThrow(() => recordMetricMeasurement(measurement));
    assert.doesNotThrow(() => recordMetricMeasurement(measurement));
  }
  resetMetricContractStateForTest();
});

test("contract validation reports malformed metadata and attribute declarations", () => {
  assert.deepEqual(validateMetricContract({ schemaVersion: 2 }), [
    "Metric contract must declare schemaVersion 1 and a metrics object.",
  ]);
  assert.deepEqual(
    validateMetricContract({
      schemaVersion: 1,
      metrics: {
        "bad.metric": {
          type: "gauge",
          unit: "",
          description: "",
          privacy: "",
          stability: "",
          cardinalityBudget: 0,
          attributes: {
            bad: {},
            enum_bad: { values: ["duplicate", "duplicate"] },
          },
          requiredAttributes: ["bad"],
        },
        "gitlab_mcp.bad_histogram": {
          type: "histogram",
          unit: "s",
          description: "Bad histogram fixture.",
          privacy: "non-sensitive",
          stability: "experimental",
          cardinalityBudget: 1,
          boundaries: [],
          attributes: {},
          requiredAttributes: [],
        },
      },
    }),
    [
      "bad.metric: invalid metric prefix.",
      "bad.metric: unsupported instrument type.",
      "bad.metric: incomplete metadata.",
      "bad.metric: unsupported privacy classification.",
      "bad.metric: unsupported stability status.",
      "bad.metric: invalid cardinality budget.",
      "bad.metric.bad: unsupported metric attribute.",
      "bad.metric.enum_bad: unsupported metric attribute.",
      "gitlab_mcp.bad_histogram: histogram boundaries required.",
    ],
  );
});

test("contract validation rejects missing, undeclared, and duplicate required attributes", () => {
  const base = {
    type: "counter",
    unit: "{event}",
    description: "Contract validation fixture.",
    privacy: "non-sensitive",
    stability: "experimental",
    cardinalityBudget: 2,
    attributes: { outcome: { values: ["success"] } },
  };
  assert.deepEqual(
    validateMetricContract({
      schemaVersion: 1,
      metrics: {
        "gitlab_mcp.no_required_list": base,
        "gitlab_mcp.bad_required_list": {
          ...base,
          requiredAttributes: ["missing", "outcome", "outcome"],
        },
      },
    }),
    [
      "gitlab_mcp.no_required_list: requiredAttributes must be an array.",
      "gitlab_mcp.bad_required_list: required attribute missing is not declared.",
      "gitlab_mcp.bad_required_list: required attribute outcome is duplicated.",
    ],
  );
});

test("observeMetric emits only the sanitized contract measurement", () => {
  resetMetricContractStateForTest();
  assert.equal(registerMetricIdentifier("tool", "get_issue"), true);
  const events = [];
  observeMetric({
    observer: (event) => events.push(event),
    metric: "gitlab_mcp.tool.calls",
    attributes: {
      tool: "get_issue",
      access: "read",
      outcome: "success",
      error_category: "none",
      project_path: "private/project",
    },
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].attributes, {
    tool: "get_issue",
    access: "read",
    outcome: "success",
    error_category: "none",
  });
  resetMetricContractStateForTest();
});

test("result size is measured after sanitization and truncation is separate", () => {
  resetMetricContractStateForTest();
  assert.equal(registerMetricIdentifier("tool", "get_issue"), true);
  const events = [];
  const result = success(
    { access_token: "forbidden", visible: "x".repeat(130_000) },
    { observer: (event) => events.push(event), tool: "get_issue" },
  );
  const size = events.find(
    (event) => event.metric === "gitlab_mcp.tool.result.size",
  );
  const truncation = events.find(
    (event) => event.metric === "gitlab_mcp.tool.presentation.truncations",
  );
  assert.ok(size.value > 120_000);
  assert.ok(truncation);
  assert.equal(result.structuredContent.result.access_token, undefined);
  assert.match(result.content[0].text, /response truncated/);
  resetMetricContractStateForTest();
});

test("GitLab logical request metrics exclude URL and identifier dimensions", async () => {
  const events = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example",
    token: "token",
    observabilityObserver: (event) => events.push(event),
    fetchImpl: async () =>
      new Response(JSON.stringify({ id: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await client.request("/projects/private%2Fproject/issues/456");
  const duration = events.find(
    (event) => event.metric === "gitlab_mcp.gitlab.request.duration",
  );
  const size = events.find(
    (event) => event.metric === "gitlab_mcp.gitlab.response.size",
  );
  assert.deepEqual(duration.attributes, {
    method: "GET",
    outcome: "success",
    status_class: "2xx",
    response_type: "json",
  });
  assert.equal(size.attributes.method, "GET");
  assert.equal(JSON.stringify(events).includes("private/project"), false);
  assert.equal(JSON.stringify(events).includes("issues/456"), false);
});

test("GitLab response size counts chunked error bytes without content-length", async () => {
  const events = [];
  const errorBody = '{"message":"bad request"}';
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(errorBody.slice(0, 10)));
      controller.enqueue(new TextEncoder().encode(errorBody.slice(10)));
      controller.close();
    },
  });
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example",
    token: "token",
    observabilityObserver: (event) => events.push(event),
    fetchImpl: async () =>
      new Response(body, {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(client.request("/projects"), /400 Bad Request/);
  const size = events.find(
    (event) => event.metric === "gitlab_mcp.gitlab.response.size",
  );
  assert.equal(size.value, Buffer.byteLength(errorBody, "utf8"));
  assert.deepEqual(size.attributes, {
    method: "GET",
    outcome: "error",
    response_type: "json",
  });
});
