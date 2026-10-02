import assert from "node:assert/strict";
import test from "node:test";

import { OBSERVABILITY_OPERATION_TOKEN } from "../src/observability.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

test("cancelled requests complete telemetry promptly", async () => {
  let releaseHandler;
  let markHandlerStarted;
  const handlerGate = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const handlerStarted = new Promise((resolve) => {
    markHandlerStarted = resolve;
  });
  const completions = [];
  const sent = [];
  let requestMetadata;

  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async send(message) {
      sent.push(message);
    },
    async close() {},
  };

  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "stdio",
    observabilityMcpScope: async (metadata, run) => {
      if (metadata.method === "tools/list") {
        requestMetadata = metadata;
      }
      return run();
    },
    observabilityMcpSent: (token, failed, ...completion) => {
      completions.push({
        token,
        failed,
        cancelled: completion[3] === true,
      });
    },
  });

  const listHandler = server.server._requestHandlers.get("tools/list");
  assert.ok(listHandler);
  server.server._requestHandlers.set("tools/list", async (request, extra) => {
    markHandlerStarted();
    await handlerGate;
    return listHandler(request, extra);
  });

  await server.connect(transport);
  transport.onmessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    params: {},
  });
  await handlerStarted;

  const requestToken = requestMetadata?.[OBSERVABILITY_OPERATION_TOKEN];
  assert.equal(typeof requestToken, "symbol");
  assert.deepEqual(completions, []);
  assert.deepEqual(sent, []);

  transport.onmessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7, reason: "test cancellation" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(completions, [
    { token: requestToken, failed: true, cancelled: true },
  ]);
  assert.deepEqual(sent, []);

  releaseHandler();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(completions, [
    { token: requestToken, failed: true, cancelled: true },
  ]);
  assert.deepEqual(sent, []);
  await server.close();
  assert.deepEqual(completions, [
    { token: requestToken, failed: true, cancelled: true },
  ]);
});

test("late cancellation cannot overtake an in-flight response send", async () => {
  let releaseSend;
  let markSendStarted;
  let markCompletion;
  const sendGate = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const sendStarted = new Promise((resolve) => {
    markSendStarted = resolve;
  });
  const completion = new Promise((resolve) => {
    markCompletion = resolve;
  });
  const completions = [];
  let requestMetadata;

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
      if (metadata.method === "tools/list") {
        requestMetadata = metadata;
      }
      return run();
    },
    observabilityMcpSent: (token, failed, ...sentCompletion) => {
      completions.push({
        token,
        failed,
        cancelled: sentCompletion[3] === true,
      });
      markCompletion();
    },
  });

  await server.connect(transport);
  transport.onmessage({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/list",
    params: {},
  });

  const outbound = await sendStarted;
  assert.equal(outbound.id, 8);
  const requestToken = requestMetadata?.[OBSERVABILITY_OPERATION_TOKEN];
  assert.equal(typeof requestToken, "symbol");

  transport.onmessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 8, reason: "late cancellation" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, []);

  releaseSend();
  await completion;
  assert.deepEqual(completions, [
    { token: requestToken, failed: false, cancelled: false },
  ]);
  await server.close();
});
