import assert from "node:assert/strict";
import test from "node:test";

import {
  OBSERVABILITY_OPERATION_STARTED_AT,
  OBSERVABILITY_OPERATION_START_TIME,
  OBSERVABILITY_OPERATION_TOKEN,
} from "../src/observability.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

test("MCP request completion waits for transport send", async () => {
  let resolveSend;
  let markSendStarted;
  let markCompletion;
  const sendGate = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const sendStarted = new Promise((resolve) => {
    markSendStarted = resolve;
  });
  const completion = new Promise((resolve) => {
    markCompletion = resolve;
  });
  const completions = [];
  let scopeMetadata;

  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async send(message) {
      markSendStarted(message);
      await sendGate;
    },
    async close() {},
  };

  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      scopeMetadata = metadata;
      return run();
    },
    observabilityMcpSent: (token, failed) => {
      completions.push({ token, failed });
      markCompletion();
    },
  });

  await server.connect(transport);
  const beforeDelivery = Date.now();
  const dispatch = transport.onmessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    params: {},
  });

  const outbound = await sendStarted;
  assert.equal(outbound.id, 7);
  assert.equal(completions.length, 0);
  assert.equal(typeof scopeMetadata[OBSERVABILITY_OPERATION_TOKEN], "symbol");
  assert.equal(
    Number.isFinite(scopeMetadata[OBSERVABILITY_OPERATION_STARTED_AT]),
    true,
  );
  assert.ok(scopeMetadata[OBSERVABILITY_OPERATION_STARTED_AT] >= 0);
  assert.ok(
    scopeMetadata[OBSERVABILITY_OPERATION_START_TIME] >= beforeDelivery,
  );
  assert.ok(scopeMetadata[OBSERVABILITY_OPERATION_START_TIME] <= Date.now());

  resolveSend();
  await completion;
  await dispatch;

  assert.equal(completions.length, 1);
  assert.equal(
    completions[0].token,
    scopeMetadata[OBSERVABILITY_OPERATION_TOKEN],
  );
  assert.equal(completions[0].failed, false);
  await server.close();
});

test("MCP notifications inherit transport timing and finish with their handler", async () => {
  let notificationMetadata;
  let notificationScopeCompleted = false;
  let releaseNotificationHandler;
  let markNotificationHandlerStarted;
  let markNotificationScopeCompleted;
  const handlerGate = new Promise((resolve) => {
    releaseNotificationHandler = resolve;
  });
  const handlerStarted = new Promise((resolve) => {
    markNotificationHandlerStarted = resolve;
  });
  const scopeCompleted = new Promise((resolve) => {
    markNotificationScopeCompleted = resolve;
  });
  const completions = [];
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async send() {},
    async close() {},
  };
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      if (metadata.method !== "notifications/initialized") {
        return run();
      }
      notificationMetadata = metadata;
      const result = await run();
      notificationScopeCompleted = true;
      markNotificationScopeCompleted();
      return result;
    },
    observabilityMcpSent: (token, failed) => {
      completions.push({ token, failed });
    },
  });
  server.server.oninitialized = async () => {
    markNotificationHandlerStarted();
    await handlerGate;
  };

  await server.connect(transport);
  const beforeDelivery = Date.now();
  transport.onmessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  await handlerStarted;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notificationScopeCompleted, false);
  assert.ok(notificationMetadata);
  assert.equal(notificationMetadata[OBSERVABILITY_OPERATION_TOKEN], undefined);
  assert.equal(
    Number.isFinite(notificationMetadata[OBSERVABILITY_OPERATION_STARTED_AT]),
    true,
  );
  assert.ok(
    notificationMetadata[OBSERVABILITY_OPERATION_START_TIME] >= beforeDelivery,
  );
  assert.ok(
    notificationMetadata[OBSERVABILITY_OPERATION_START_TIME] <= Date.now(),
  );
  assert.deepEqual(completions, []);

  releaseNotificationHandler();
  await scopeCompleted;
  assert.equal(notificationScopeCompleted, true);
  await server.close();
});

test("concurrent duplicate request ids never misassociate completion", async () => {
  let releaseFirstScope;
  let markFirstScopeStarted;
  const firstScopeGate = new Promise((resolve) => {
    releaseFirstScope = resolve;
  });
  const firstScopeStarted = new Promise((resolve) => {
    markFirstScopeStarted = resolve;
  });
  const metadata = [];
  const completions = [];
  let scopeCalls = 0;

  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async send() {},
    async close() {},
  };
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (value, run) => {
      scopeCalls += 1;
      metadata.push(value);
      if (scopeCalls === 1) {
        markFirstScopeStarted();
        await firstScopeGate;
      }
      return run();
    },
    observabilityMcpSent: (token, failed) => {
      completions.push({ token, failed });
    },
  });

  await server.connect(transport);
  const firstDispatch = transport.onmessage({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: {},
  });
  await firstScopeStarted;
  const firstToken = metadata[0][OBSERVABILITY_OPERATION_TOKEN];
  assert.equal(typeof firstToken, "symbol");

  const secondDispatch = transport.onmessage({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(completions, [{ token: firstToken, failed: true }]);

  releaseFirstScope();
  await Promise.all([firstDispatch, secondDispatch]);

  assert.equal(metadata.length, 2);
  assert.equal(metadata[1][OBSERVABILITY_OPERATION_TOKEN], undefined);
  assert.equal(
    Number.isFinite(metadata[1][OBSERVABILITY_OPERATION_STARTED_AT]),
    true,
  );
  assert.deepEqual(completions, [{ token: firstToken, failed: true }]);
  await server.close();
});
