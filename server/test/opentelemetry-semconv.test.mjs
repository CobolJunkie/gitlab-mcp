import assert from "node:assert/strict";
import test from "node:test";

import {
  OBSERVABILITY_EVENTS,
  observeToolCall,
  runToolObservationScope,
} from "../src/observability.mjs";
import {
  classifyMcpServerCompletion,
  EXECUTE_TOOL_DURATION_BOUNDARIES,
  MCP_SEMCONV,
  MCP_SERVER_OPERATION_DURATION_BOUNDARIES,
  mcpTransportAttributes,
  toExecuteToolDuration,
} from "../src/opentelemetry-semconv.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";
import { createToolRegistrar } from "../src/tools/register.mjs";

const EXPECTED_MCP_DURATION_BOUNDARIES = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
];
const EXPECTED_EXECUTE_TOOL_DURATION_BOUNDARIES = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

function fakeServer() {
  const registrations = new Map();
  return {
    registrations,
    registerTool(name, config, handler) {
      registrations.set(name, { config, handler });
    },
  };
}

function toolCallEvents(events) {
  return events.filter(
    (event) => event.event === OBSERVABILITY_EVENTS.TOOL_CALL,
  );
}

test("maps OBS-01 tool completions to execute-tool duration", () => {
  const event = observeToolCall({
    tool: "get_project",
    readOnly: true,
    deploymentMode: "stdio",
    outcome: "success",
    startedAt: 10,
    endedAt: 260,
  });
  const measurement = toExecuteToolDuration(event);

  assert.deepEqual(measurement, {
    name: "gen_ai.execute_tool.duration",
    unit: "s",
    value: 0.25,
    attributes: { "gen_ai.tool.name": "get_project" },
  });
  assert.equal(MCP_SEMCONV.status, "development");
  assert.equal(MCP_SEMCONV.snapshotDate, "2026-09-09");
  assert.deepEqual(
    MCP_SERVER_OPERATION_DURATION_BOUNDARIES,
    EXPECTED_MCP_DURATION_BOUNDARIES,
  );
  assert.deepEqual(
    EXECUTE_TOOL_DURATION_BOUNDARIES,
    EXPECTED_EXECUTE_TOOL_DURATION_BOUNDARIES,
  );
});

test("maps bounded MCP transport attributes", () => {
  assert.deepEqual(mcpTransportAttributes("stdio"), {
    "network.transport": "pipe",
  });
  assert.deepEqual(mcpTransportAttributes("http"), {
    "network.transport": "tcp",
    "network.protocol.name": "http",
  });
  assert.deepEqual(mcpTransportAttributes("embedded"), {});
});

test("bounds MCP response status cardinality", () => {
  assert.deepEqual(
    classifyMcpServerCompletion({ responseStatusCode: "-32601" }),
    {
      responseStatusCode: "-32601",
      isError: false,
    },
  );
  assert.deepEqual(
    classifyMcpServerCompletion({ responseStatusCode: "-32603" }),
    {
      responseStatusCode: "-32603",
      errorType: "-32603",
      isError: true,
    },
  );

  const arbitrary = classifyMcpServerCompletion({
    responseStatusCode: "2147483647",
  });
  assert.deepEqual(arbitrary, {
    responseStatusCode: "other_error",
    errorType: "other_error",
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(arbitrary), /2147483647/u);
});

test("maps tool failures without private error data", () => {
  const canary = "CANARY_OTEL_PRIVATE_VALUE";
  const measurement = toExecuteToolDuration({
    event: OBSERVABILITY_EVENTS.TOOL_CALL,
    tool: "get_project",
    outcome: "error",
    errorType: "TimeoutError",
    durationMs: 50,
    privateValue: canary,
  });
  assert.deepEqual(measurement.attributes, {
    "gen_ai.tool.name": "get_project",
    "error.type": "TimeoutError",
  });
  assert.doesNotMatch(JSON.stringify(measurement), new RegExp(canary));
});

test("tool scopes fail open and execute the operation once", async () => {
  let calls = 0;
  let metadata;
  const result = await runToolObservationScope({
    scope: async (value, run) => {
      metadata = value;
      const first = await run();
      const second = await run();
      assert.strictEqual(first, second);
      throw new Error("telemetry unavailable");
    },
    tool: "get_project",
    readOnly: true,
    deploymentMode: "stdio",
    operation: async () => {
      calls += 1;
      return { id: 1 };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: 1 });
  assert.deepEqual(metadata, {
    tool: "get_project",
    readOnly: true,
    deploymentMode: "stdio",
  });
  assert.equal(Object.isFrozen(metadata), true);
});

test("scope failure before invocation still executes once", async () => {
  let calls = 0;
  const result = await runToolObservationScope({
    scope: async () => {
      throw new Error("tracer unavailable");
    },
    tool: "get_project",
    readOnly: true,
    deploymentMode: "http",
    operation: async () => {
      calls += 1;
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("operation failures are preserved through the tool scope", async () => {
  const expected = new TypeError("product failure");
  let calls = 0;
  const operation = runToolObservationScope({
    scope: async (_metadata, run) => run(),
    tool: "get_project",
    readOnly: true,
    deploymentMode: "http",
    operation: async () => {
      calls += 1;
      throw expected;
    },
  });
  await assert.rejects(operation, (error) => error === expected);
  assert.equal(calls, 1);
});

test("registrar emits completion before tool scope exits", async () => {
  const server = fakeServer();
  const scopes = [];
  const events = [];
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityObserver: (event) => events.push(event),
    observabilityToolScope: async (metadata, run) => {
      scopes.push(metadata);
      const result = await run();
      const [event] = toolCallEvents(events);
      assert.equal(toolCallEvents(events).length, 1);
      assert.equal(event.event, OBSERVABILITY_EVENTS.TOOL_CALL);
      return result;
    },
  });
  tool("get_project", { annotations: { readOnlyHint: true } }, async () => ({
    id: 1,
  }));
  const response = await server.registrations
    .get("get_project")
    .handler({}, {});
  assert.deepEqual(response.structuredContent, { result: { id: 1 } });
  assert.deepEqual(scopes, [
    { tool: "get_project", readOnly: true, deploymentMode: "stdio" },
  ]);
  const [event] = toolCallEvents(events);
  assert.equal(toolCallEvents(events).length, 1);
  assert.equal(event.outcome, "success");
});

test("core tools/call handler wraps the MCP handler boundary", async () => {
  const scopes = [];
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      scopes.push({ phase: "before", metadata });
      const result = await run();
      scopes.push({ phase: "after", isError: result?.isError === true });
      return result;
    },
  });
  const handler = server.server._requestHandlers.get("tools/call");
  assert.ok(handler);
  const response = await handler(
    {
      method: "tools/call",
      params: {
        name: "get_runtime_info",
        arguments: {},
        _meta: {
          traceparent,
          tracestate: "private-vendor-state-must-not-propagate",
          privateValue: "must-not-enter-scope-metadata",
        },
      },
    },
    {},
  );
  assert.equal(response.isError, undefined);
  assert.deepEqual(scopes[0], {
    phase: "before",
    metadata: {
      method: "tools/call",
      tool: "get_runtime_info",
      readOnly: false,
      deploymentMode: "stdio",
      traceContext: { traceparent },
    },
  });
  assert.deepEqual(scopes[1], { phase: "after", isError: false });
});

test("core MCP observability covers non-tool requests and notifications", async () => {
  const seen = [];
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      seen.push(metadata);
      return run();
    },
  });
  const listHandler = server.server._requestHandlers.get("tools/list");
  assert.ok(listHandler);
  await listHandler({ method: "tools/list", params: {} }, {});
  const initializedHandler = server.server._notificationHandlers.get(
    "notifications/initialized",
  );
  assert.ok(initializedHandler);
  await initializedHandler(
    { method: "notifications/initialized", params: {} },
    {},
  );
  assert.deepEqual(seen, [
    { method: "tools/list", readOnly: false, deploymentMode: "stdio" },
    {
      method: "notifications/initialized",
      readOnly: false,
      deploymentMode: "stdio",
    },
  ]);
});

test("unknown MCP tool names are collapsed before telemetry", async () => {
  const seen = [];
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "http",
    observabilityMcpScope: async (metadata, run) => {
      seen.push(metadata);
      return run();
    },
  });
  const handler = server.server._requestHandlers.get("tools/call");
  await handler(
    {
      method: "tools/call",
      params: { name: "private-user-controlled-tool-name", arguments: {} },
    },
    {},
  );
  assert.equal(seen[0].method, "tools/call");
  assert.equal(seen[0].tool, "unknown_tool");
});
