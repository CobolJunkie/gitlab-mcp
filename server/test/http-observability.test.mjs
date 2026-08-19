import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createHttpApp } from "../src/http.mjs";

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function completionPromise() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function requestWithHostHeader(baseUrl, path, host) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("emits bounded core and legacy observations for known routes", async (t) => {
  const core = completionPromise();
  const legacy = completionPromise();
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    requestIdFactory: () => "request-123",
    observabilityObserver: core.resolve,
    requestObserver: legacy.resolve,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "request-123");
  await response.json();

  const coreEvent = await core.promise;
  assert.deepEqual(
    { ...coreEvent, durationMs: undefined },
    {
      schemaVersion: 1,
      event: "http_request",
      requestId: "request-123",
      method: "GET",
      route: "health",
      status: 200,
      outcome: "success",
      durationMs: undefined,
    },
  );
  assert.ok(coreEvent.durationMs >= 0);

  const legacyEvent = await legacy.promise;
  assert.deepEqual(
    { ...legacyEvent, durationMs: undefined },
    {
      requestId: "request-123",
      method: "GET",
      path: "/health",
      status: 200,
      durationMs: undefined,
    },
  );
  assert.ok(legacyEvent.durationMs >= 0);
});

test("classifies router-equivalent known route variants consistently", async (t) => {
  const core = completionPromise();
  const legacy = completionPromise();
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    requestIdFactory: () => "request-route-variant",
    observabilityObserver: core.resolve,
    requestObserver: legacy.resolve,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/HEALTH/`);
  assert.equal(response.status, 200);
  await response.json();

  const coreEvent = await core.promise;
  const legacyEvent = await legacy.promise;
  assert.equal(coreEvent.route, "health");
  assert.equal(coreEvent.status, 200);
  assert.equal(coreEvent.outcome, "success");
  assert.equal(legacyEvent.path, "/health");
});

test("preserves known route identity when host validation rejects before routing", async (t) => {
  const canaryQuery = "CANARY_REJECTED_QUERY_SECRET";
  const core = completionPromise();
  const legacy = completionPromise();
  const { app } = createHttpApp({
    host: "127.0.0.1",
    allowedHosts: ["mcp.example.com"],
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    requestIdFactory: () => "request-rejected-host",
    observabilityObserver: core.resolve,
    requestObserver: legacy.resolve,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const status = await requestWithHostHeader(
    state.baseUrl,
    `/health?token=${canaryQuery}`,
    "rejected.example.com",
  );
  assert.equal(status, 403);

  const coreEvent = await core.promise;
  const legacyEvent = await legacy.promise;
  assert.equal(coreEvent.route, "health");
  assert.equal(coreEvent.status, 403);
  assert.equal(coreEvent.outcome, "error");
  assert.equal(legacyEvent.path, "/health");
  assert.doesNotMatch(
    JSON.stringify({ coreEvent, legacyEvent }),
    new RegExp(canaryQuery),
  );
});

test("never copies unmatched raw paths or query values into observations", async (t) => {
  const canaryPath = "CANARY_PATH_SECRET";
  const canaryQuery = "CANARY_QUERY_SECRET";
  const core = completionPromise();
  const legacy = completionPromise();
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    requestIdFactory: () => "request-404",
    observabilityObserver: core.resolve,
    requestObserver: legacy.resolve,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(
    `${state.baseUrl}/private/${canaryPath}?token=${canaryQuery}`,
  );
  assert.equal(response.status, 404);

  const coreEvent = await core.promise;
  const legacyEvent = await legacy.promise;
  assert.equal(coreEvent.route, "unmatched");
  assert.equal(coreEvent.outcome, "error");
  assert.equal(legacyEvent.path, "<unmatched>");
  const serialized = JSON.stringify({ coreEvent, legacyEvent });
  assert.doesNotMatch(serialized, new RegExp(canaryPath));
  assert.doesNotMatch(serialized, new RegExp(canaryQuery));
});

test("observer failures cannot alter HTTP responses", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    observabilityObserver() {
      throw new Error("observer unavailable");
    },
    requestObserver() {
      return Promise.reject(new Error("legacy observer unavailable"));
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "gitlab-mcp",
  });
});
