import assert from "node:assert/strict";
import test from "node:test";

import {
  OBSERVABILITY_EVENTS,
  OBSERVABILITY_SCHEMA_VERSION,
  classifyHttpRoute,
  observabilityErrorCategory,
  observeHttpRequest,
  observeToolCall,
  observationDurationMs,
} from "../src/observability.mjs";
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

function toolCallEvents(events) {
  return events.filter(
    (event) => event.event === OBSERVABILITY_EVENTS.TOOL_CALL,
  );
}

test("classifies only known HTTP routes and bounds duration", () => {
  assert.equal(OBSERVABILITY_SCHEMA_VERSION, 2);
  assert.equal(classifyHttpRoute("/health"), "health");
  assert.equal(classifyHttpRoute("/HEALTH/"), "health");
  assert.equal(classifyHttpRoute("/ready"), "readiness");
  assert.equal(classifyHttpRoute("/mcp"), "mcp");
  assert.equal(
    classifyHttpRoute([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]),
    "oauth_metadata",
  );
  assert.equal(
    classifyHttpRoute("/.WELL-KNOWN/OAUTH-PROTECTED-RESOURCE/MCP/"),
    "oauth_metadata",
  );
  assert.equal(classifyHttpRoute("/health//"), "unmatched");
  assert.equal(classifyHttpRoute("/arbitrary/secret-value"), "unmatched");
  assert.equal(observationDurationMs(10, 12.345), 2.35);
  assert.equal(observationDurationMs(12, 10), 0);
});

test("HTTP observations expose only bounded completion metadata", () => {
  const events = [];
  const legacyEvents = [];
  const event = observeHttpRequest({
    observer: (value) => events.push(value),
    requestObserver: (value) => {
      value.compatibilityMarker = true;
      legacyEvents.push(value);
    },
    requestId: "request-123",
    method: "GET",
    routePath: "/health",
    status: 200,
    startedAt: 10,
    endedAt: 12,
  });

  assert.deepEqual(event, {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.HTTP_REQUEST,
    requestId: "request-123",
    method: "GET",
    route: "health",
    status: 200,
    outcome: "success",
    durationMs: 2,
  });
  assert.deepEqual(events, [event]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.deepEqual(legacyEvents, [
    {
      requestId: "request-123",
      method: "GET",
      path: "/health",
      status: 200,
      durationMs: 2,
      compatibilityMarker: true,
    },
  ]);
  assert.equal(Object.isFrozen(legacyEvents[0]), false);
});

test("HTTP observations derive bounded outcomes from status", () => {
  const failure = observeHttpRequest({
    requestId: "request-404",
    method: "GET",
    routePath: "/health",
    status: 404,
    startedAt: 10,
    endedAt: 11,
  });
  const unknown = observeHttpRequest({
    requestId: "request-invalid",
    method: "GET",
    routePath: "/health",
    status: 999,
    startedAt: 10,
    endedAt: 11,
  });

  assert.equal(failure.outcome, "error");
  assert.equal(unknown.status, 0);
  assert.equal(unknown.outcome, "unknown");
});

test("HTTP observations never copy arbitrary routes or identifiers", () => {
  const canary = "CANARY_HTTP_SECRET";
  const event = observeHttpRequest({
    requestId: `${canary} with spaces`,
    method: canary,
    routePath: `/private/${canary}`,
    status: 999,
    startedAt: 10,
    endedAt: 11,
  });

  assert.deepEqual(event, {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.HTTP_REQUEST,
    requestId: "unknown",
    method: "OTHER",
    route: "unmatched",
    status: 0,
    outcome: "unknown",
    durationMs: 1,
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(canary));
});

test("tool observations expose only allowlisted metadata", async () => {
  const canary = "CANARY_TOOL_SECRET";
  const server = fakeServer();
  const events = [];
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityObserver: (event) => events.push(event),
  });

  tool(
    "get_project",
    { annotations: { readOnlyHint: true } },
    async (_client, args) => ({ received: args.privateValue }),
  );
  await server.registrations
    .get("get_project")
    .handler({ privateValue: canary }, {});

  const [event] = toolCallEvents(events);
  assert.equal(toolCallEvents(events).length, 1);
  assert.deepEqual(
    { ...event, durationMs: undefined },
    {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      event: OBSERVABILITY_EVENTS.TOOL_CALL,
      tool: "get_project",
      readOnly: true,
      deploymentMode: "stdio",
      outcome: "success",
      durationMs: undefined,
    },
  );
  assert.ok(event.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(canary));
});

test("tool failures expose a bounded error type", async () => {
  const canary = "CANARY_ERROR_SECRET";
  const server = fakeServer();
  const events = [];
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    deploymentMode: "http",
    observabilityObserver: (event) => events.push(event),
  });

  tool("get_project", { annotations: { readOnlyHint: true } }, async () => {
    const error = new Error(canary);
    error.name = `${canary}Error`;
    error.stack = canary;
    throw error;
  });
  await server.registrations.get("get_project").handler({}, {});

  const [event] = toolCallEvents(events);
  assert.equal(toolCallEvents(events).length, 1);
  assert.equal(event.outcome, "error");
  assert.equal(event.errorType, "Error");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(canary));
});

test("response shaping failures remain failed tool observations", async () => {
  const server = fakeServer();
  const events = [];
  const result = {};
  Object.defineProperty(result, "value", {
    enumerable: true,
    get() {
      throw new TypeError("response shaping failed");
    },
  });
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    observabilityObserver: (event) => events.push(event),
  });

  tool(
    "get_project",
    { annotations: { readOnlyHint: true } },
    async () => result,
  );
  const response = await server.registrations
    .get("get_project")
    .handler({}, {});

  const [event] = toolCallEvents(events);
  const callMetric = events.find(
    (candidate) => candidate.metric === "gitlab_mcp.tool.calls",
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.result.error, "TypeError");
  assert.equal(toolCallEvents(events).length, 1);
  assert.equal(event.outcome, "error");
  assert.equal(event.errorType, "TypeError");
  assert.equal(callMetric.attributes.error_category, "internal");
});

test("validation error categories require an explicit bounded hint", () => {
  assert.equal(
    observabilityErrorCategory(new TypeError("internal type failure")),
    "internal",
  );
  const validationError = new TypeError("known validation failure");
  Object.defineProperty(validationError, "observabilityCategory", {
    configurable: false,
    enumerable: false,
    value: "validation",
    writable: false,
  });
  assert.equal(observabilityErrorCategory(validationError), "validation");
});

test("error metadata access cannot make observation fail closed", async () => {
  const server = fakeServer();
  const events = [];
  let nameReads = 0;
  const error = new Error("safe failure");
  Object.defineProperty(error, "name", {
    get() {
      nameReads += 1;
      if (nameReads > 1) {
        throw new Error("name accessor unavailable");
      }
      return "Error";
    },
  });
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    observabilityObserver: (event) => events.push(event),
  });

  tool("get_project", { annotations: { readOnlyHint: true } }, async () => {
    throw error;
  });

  const response = await server.registrations
    .get("get_project")
    .handler({}, {});
  const [event] = toolCallEvents(events);
  assert.equal(response.isError, true);
  assert.equal(toolCallEvents(events).length, 1);
  assert.equal(event.errorType, "Error");
});

test("observer failures never alter tool behavior", async () => {
  const server = fakeServer();
  const { tool } = createToolRegistrar({
    server,
    clientFactory: () => ({}),
    observabilityObserver() {
      throw new Error("observer unavailable");
    },
  });

  tool("get_project", { annotations: { readOnlyHint: true } }, async () => ({
    id: 1,
  }));

  const response = await server.registrations
    .get("get_project")
    .handler({}, {});
  assert.deepEqual(response.structuredContent, { result: { id: 1 } });
  assert.equal(response.isError, undefined);
});

test("direct tool observations normalize untrusted categorical values", () => {
  const canary = "CANARY_DIRECT_SECRET";
  const event = observeToolCall({
    tool: `${canary} with spaces`,
    readOnly: "yes",
    deploymentMode: canary,
    outcome: "unexpected",
    error: Object.assign(new Error(canary), { name: canary }),
    startedAt: 5,
    endedAt: 6,
  });

  assert.deepEqual(event, {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    event: OBSERVABILITY_EVENTS.TOOL_CALL,
    tool: "unknown",
    readOnly: false,
    deploymentMode: "unknown",
    outcome: "success",
    durationMs: 1,
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(canary));
});
