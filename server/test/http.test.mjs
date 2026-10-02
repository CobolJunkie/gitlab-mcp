import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import {
  DEFAULT_MCP_REQUEST_BYTES,
  DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS,
  MAX_MCP_REQUEST_BYTES,
  MAX_REQUEST_BODY_READ_TIMEOUT_MS,
  MIN_PORT,
  MAX_PORT,
  checkGitLabReadiness,
  createHttpApp,
  parsePort,
  parseRequestBodyLimit,
  shutdownHttpServer,
  startHttpServer,
} from "../src/http.mjs";

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
      } else {
        const address = server.address();
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${address.port}`,
        });
      }
    });
  });
}

function requestTools(baseUrl, token) {
  return requestMcp(baseUrl, token, "tools/list", {});
}

function requestMcp(baseUrl, token, method, params) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

function tokenValidationError(
  status,
  message = "fixture token validation failure",
) {
  return new GitLabApiError(message, {
    ...(status === undefined ? undefined : { status }),
    method: "GET",
    path: "/user",
  });
}

async function listenRaw(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("serves health and protected-resource metadata without credentials", async (t) => {
  const { app, metadata } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    readinessCheck: async () => true,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const health = await fetch(`${state.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "gitlab-mcp",
  });

  const response = await fetch(
    `${state.baseUrl}/.well-known/oauth-protected-resource`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), metadata);
  assert.deepEqual(metadata.authorization_servers, [
    "https://gitlab.example.com",
  ]);
  const ready = await fetch(`${state.baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: "ready",
    service: "gitlab-mcp",
  });
});

test("separates liveness from dependency readiness", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://internal-gitlab.example.com",
    readinessCheck: async () => false,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const health = await fetch(`${state.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.doesNotMatch(JSON.stringify(await health.json()), /internal-gitlab/);

  const ready = await fetch(`${state.baseUrl}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: "unavailable",
    service: "gitlab-mcp",
  });
});

test("validates the canonical public MCP URL", () => {
  assert.throws(
    () => createHttpApp({ requirePublicUrl: true, publicUrl: undefined }),
    /MCP_PUBLIC_URL is required/,
  );
  assert.throws(
    () => createHttpApp({ publicUrl: "http://mcp.example.com/mcp" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => createHttpApp({ publicUrl: "https://user:pass@mcp.example.com/mcp" }),
    /embedded credentials/,
  );
  for (const publicUrl of [
    "https://mcp.example.com/mcp?debug=1",
    "https://mcp.example.com/mcp#debug",
    "https://mcp.example.com/mcp?",
    "https://mcp.example.com/mcp#",
    "https://mcp.example.com/mcp?#",
  ]) {
    assert.throws(() => createHttpApp({ publicUrl }), /query or fragment/);
  }
  for (const publicUrl of [
    "https://mcp.example.com/connectors%3Fgitlab/mcp",
    "https://mcp.example.com/connectors%23gitlab/mcp",
  ]) {
    assert.equal(
      createHttpApp({ publicUrl }).resourceUrl.toString(),
      publicUrl,
    );
  }
  assert.throws(
    () => createHttpApp({ publicUrl: "https://mcp.example.com/service" }),
    /path must end with \/mcp/,
  );

  const local = createHttpApp({
    publicUrl: "http://127.0.0.1:3000/",
    allowInsecurePublicUrl: true,
  });
  assert.equal(local.resourceUrl.toString(), "http://127.0.0.1:3000/mcp");
  const prefixed = createHttpApp({
    publicUrl: "https://mcp.example.com/connectors/gitlab/mcp/",
  });
  assert.equal(
    prefixed.resourceUrl.toString(),
    "https://mcp.example.com/connectors/gitlab/mcp",
  );
  assert.throws(
    () =>
      createHttpApp({
        host: "127.0.0.1",
        publicUrl: "http://127.0.0.1:3000/mcp",
        allowInsecurePublicUrl: true,
        requirePublicUrl: true,
      }),
    /permitted only for local development/,
  );
  assert.throws(
    () =>
      createHttpApp({
        host: "0.0.0.0",
        allowedHosts: ["mcp.example.com"],
        publicUrl: "http://mcp.example.com/mcp",
        allowInsecurePublicUrl: true,
      }),
    /permitted only for local development/,
  );
  assert.throws(
    () =>
      createHttpApp({
        host: "127.0.0.1",
        publicUrl: "https://mcp.example.com/mcp",
        allowServerToken: true,
      }),
    /permitted only for a loopback/,
  );
  assert.doesNotThrow(() =>
    createHttpApp({
      host: "127.0.0.1",
      publicUrl: "http://127.0.0.1:3000/mcp",
      allowInsecurePublicUrl: true,
      allowInsecureGitLabUrl: true,
      gitlabUrl: "http://127.0.0.1:8080/gitlab",
      allowServerToken: true,
    }),
  );
});

test("returns sanitized JSON-RPC errors for malformed and unsupported requests", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const malformed = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type"), /application\/json/);
  assert.match(malformed.headers.get("x-request-id"), /.+/);
  assert.deepEqual(await malformed.json(), {
    jsonrpc: "2.0",
    error: { code: -32700, message: "Parse error." },
    id: null,
  });

  const bomPrefixed = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      ),
    ]),
  });
  assert.equal(bomPrefixed.status, 400);
  assert.deepEqual(await bomPrefixed.json(), {
    jsonrpc: "2.0",
    error: { code: -32700, message: "Parse error." },
    id: null,
  });

  const replacementCharacter = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "replacement-\uFFFD",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(replacementCharacter.status, 200);
  const replacementCharacterBody = await replacementCharacter.json();
  assert.equal(replacementCharacterBody.id, "replacement-\uFFFD");
  assert.ok(Array.isArray(replacementCharacterBody.result?.tools));

  let malformedUtf8ServerCreations = 0;
  const malformedUtf8App = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidator: async () => ({ id: 7, username: "tester" }),
    serverFactory: () => {
      malformedUtf8ServerCreations += 1;
      return new McpServer({ name: "malformed-utf8-test", version: "1.0.0" });
    },
  }).app;
  const malformedUtf8State = await listen(malformedUtf8App);
  t.after(
    () => new Promise((resolve) => malformedUtf8State.server.close(resolve)),
  );
  const malformedUtf8Body = Buffer.concat([
    Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"value":"',
    ),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}}'),
  ]);
  const malformedUtf8 = await fetch(`${malformedUtf8State.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: malformedUtf8Body,
  });
  assert.equal(malformedUtf8.status, 400);
  assert.deepEqual(await malformedUtf8.json(), {
    jsonrpc: "2.0",
    error: { code: -32700, message: "Parse error." },
    id: null,
  });
  assert.equal(malformedUtf8ServerCreations, 0);

  const unsupported = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "text/plain",
    },
    body: "{}",
  });
  assert.equal(unsupported.status, 415);
  assert.deepEqual(await unsupported.json(), {
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message: "MCP requests must use Content-Type: application/json.",
    },
    id: null,
  });
});

test("readiness recognizes GitLab API responses instead of generic reachability", async (t) => {
  const state = await listenRaw((req, res) => {
    if (req.url !== "/api/v4/user") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = state.status;
    const contentType = state.contentType || "application/json";
    res.setHeader("content-type", contentType);
    res.end(state.body || "");
  });
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // 404 → false (not a recognized GitLab status)
  state.status = 404;
  state.body = "";
  state.contentType = "application/json";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);

  // 401 with valid JSON → true
  state.status = 401;
  state.body = JSON.stringify({ message: "401 Unauthorized" });
  state.contentType = "application/json";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), true);

  // 401 with HTML body → false (misrouted proxy/WAF)
  state.status = 401;
  state.body = "<html><body>401 Unauthorized</body></html>";
  state.contentType = "text/html";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);

  // 403 with non-JSON content-type → false
  state.status = 403;
  state.body = "Forbidden";
  state.contentType = "text/plain";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);

  // 401 with malformed JSON → false
  state.status = 401;
  state.body = "{not valid json";
  state.contentType = "application/json";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);

  // 200 with valid JSON object → true
  state.status = 200;
  state.body = JSON.stringify({ id: 1, username: "test" });
  state.contentType = "application/json";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), true);

  // 200 with non-object JSON (array) → false
  state.status = 200;
  state.body = JSON.stringify([1, 2, 3]);
  state.contentType = "application/json";
  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);
});

test("adds privacy-safe request IDs and completion observations", async (t) => {
  let observed;
  const observation = new Promise((resolve) => {
    observed = resolve;
  });
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    requestIdFactory: () => "request-123",
    requestObserver: observed,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/health`);
  assert.equal(response.headers.get("x-request-id"), "request-123");
  await response.json();
  const completed = await observation;
  assert.deepEqual(
    {
      ...completed,
      durationMs: undefined,
    },
    {
      requestId: "request-123",
      method: "GET",
      path: "/health",
      status: 200,
      durationMs: undefined,
    },
  );
  assert.ok(completed.durationMs >= 0);
});

test("challenges unauthenticated MCP requests with RFC 9728 metadata", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    allowServerToken: false,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate"),
    /oauth-protected-resource/,
  );
  assert.match(
    response.headers.get("www-authenticate"),
    /error="invalid_token"/,
  );
  assert.match(response.headers.get("www-authenticate"), /error_description=/);
});

test("advertises OAuth security schemes through the HTTP tools list", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    allowServerToken: false,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.tools.length, 175);
  assert.deepEqual(payload.result.tools[0].securitySchemes, [
    { type: "oauth2", scopes: ["api"] },
  ]);
  assert.deepEqual(payload.result.tools[0]._meta.securitySchemes, [
    { type: "oauth2", scopes: ["api"] },
  ]);
});

test("exposes only read-only tools and read_api OAuth scope in read-only mode", async (t) => {
  const { app, metadata } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    readOnly: true,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  assert.deepEqual(metadata.scopes_supported, ["read_api"]);
  const response = await requestTools(state.baseUrl, "read-only-token");
  assert.equal(response.status, 200);
  const tools = (await response.json()).result.tools;
  assert.equal(tools.length, 87);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(
    tools.every(
      (tool) =>
        JSON.stringify(tool.securitySchemes) ===
        JSON.stringify([{ type: "oauth2", scopes: ["read_api"] }]),
    ),
  );
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has("get_project"));
  assert.ok(names.has("list_merge_requests"));
  assert.equal(names.has("create_issue"), false);
  assert.equal(names.has("merge_merge_request"), false);

  const challenge = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate"), /scope="read_api"/);
});

test("rejects bearer tokens that GitLab does not accept", async (t) => {
  let validationCalls = 0;
  const { app } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidator: async () => {
      validationCalls += 1;
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer rejected-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(validationCalls, 1);
  assert.match(response.headers.get("www-authenticate"), /invalid_token/);
  assert.deepEqual(await response.json(), {
    error: "invalid_token",
    message: "GitLab rejected the connected access token.",
  });
});

test("returns insufficient_scope for GitLab 403 without poisoning invalid-credential state", async (t) => {
  let validationCalls = 0;
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 1,
    tokenValidator: async () => {
      validationCalls += 1;
      throw tokenValidationError(403);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestTools(state.baseUrl, "forbidden-token");
    assert.equal(response.status, 403);
    assert.match(
      response.headers.get("www-authenticate"),
      /insufficient_scope/,
    );
    assert.deepEqual(await response.json(), {
      error: "insufficient_scope",
      message:
        "GitLab did not authorize the connected access token for the required scope.",
    });
  }

  assert.equal(validationCalls, 2);
  assert.equal(diagnostics.authenticationFailureKeyCount(), 0);
});

test("keeps transient GitLab validation failures out of invalid-credential state", async (t) => {
  let validationCalls = 0;
  const secret = "private-upstream-detail";
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 1,
    authValidationLimit: 5,
    authValidationWindowMs: 60_000,
    tokenValidator: async ({ token }) => {
      validationCalls += 1;
      if (token === "rate-limited") {
        throw tokenValidationError(429, `rate limited ${secret}`);
      }
      if (token === "unavailable") {
        throw tokenValidationError(503, `service unavailable ${secret}`);
      }
      if (token === "timeout") {
        return Promise.reject(
          new GitLabApiError(`timed out ${secret}`, {
            method: "GET",
            path: "/user",
            observabilityCategory: "timeout",
          }),
        );
      }
      throw new Error(`network failure ${secret}`);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  for (const token of [
    "rate-limited",
    "rate-limited",
    "unavailable",
    "timeout",
    "network",
  ]) {
    const response = await requestTools(state.baseUrl, token);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("www-authenticate"), null);
    const body = await response.json();
    assert.deepEqual(body, {
      error: "temporarily_unavailable",
      message:
        "GitLab token validation is temporarily unavailable. Retry later.",
    });
    assert.equal(JSON.stringify(body).includes(secret), false);
  }

  assert.equal(validationCalls, 5);
  assert.equal(diagnostics.authenticationFailureKeyCount(), 0);
  assert.equal(diagnostics.validationBudgetCount(), 5);

  const budgetBlocked = await requestTools(state.baseUrl, "another-token");
  assert.equal(budgetBlocked.status, 429);
  assert.equal(validationCalls, 5);
  assert.equal(diagnostics.authenticationFailureKeyCount(), 0);
});

test("transient validation failure preserves a concurrent successful cache entry", async (t) => {
  let validationCalls = 0;
  let resolveFirst;
  let rejectSecond;
  let markFirstStarted;
  let markSecondStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    markSecondStarted = resolve;
  });
  const firstValidation = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const secondValidation = new Promise((_, reject) => {
    rejectSecond = reject;
  });

  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidator: async () => {
      validationCalls += 1;
      if (validationCalls === 1) {
        markFirstStarted();
        return firstValidation;
      }
      if (validationCalls === 2) {
        markSecondStarted();
        return secondValidation;
      }
      return { id: 7, username: "tester" };
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const firstRequest = requestTools(state.baseUrl, "shared-token");
  await firstStarted;
  const secondRequest = requestTools(state.baseUrl, "shared-token");
  await secondStarted;

  resolveFirst({ id: 7, username: "tester" });
  assert.equal((await firstRequest).status, 200);
  assert.equal(diagnostics.validatedTokenCount(), 1);

  rejectSecond(tokenValidationError(503));
  assert.equal((await secondRequest).status, 503);
  assert.equal(diagnostics.validatedTokenCount(), 1);
  assert.equal(diagnostics.authenticationFailureKeyCount(), 0);

  assert.equal((await requestTools(state.baseUrl, "shared-token")).status, 200);
  assert.equal(validationCalls, 2);
  assert.equal(diagnostics.validationBudgetCount(), 2);
});

test("authoritative validation failure invalidates a concurrent successful cache entry", async (t) => {
  for (const status of [401, 403]) {
    await t.test(`GitLab ${status}`, async (t) => {
      let validationCalls = 0;
      let resolveFirst;
      let rejectSecond;
      let markFirstStarted;
      let markSecondStarted;
      const firstStarted = new Promise((resolve) => {
        markFirstStarted = resolve;
      });
      const secondStarted = new Promise((resolve) => {
        markSecondStarted = resolve;
      });
      const firstValidation = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const secondValidation = new Promise((_, reject) => {
        rejectSecond = reject;
      });

      const { app, diagnostics } = createHttpApp({
        host: "127.0.0.1",
        publicUrl: "https://mcp.example.com/mcp",
        gitlabUrl: "https://gitlab.example.com",
        tokenValidator: async () => {
          validationCalls += 1;
          if (validationCalls === 1) {
            markFirstStarted();
            return firstValidation;
          }
          if (validationCalls === 2) {
            markSecondStarted();
            return secondValidation;
          }
          return { id: 7, username: "tester" };
        },
      });
      const state = await listen(app);
      t.after(() => new Promise((resolve) => state.server.close(resolve)));

      const firstRequest = requestTools(state.baseUrl, "shared-token");
      await firstStarted;
      const secondRequest = requestTools(state.baseUrl, "shared-token");
      await secondStarted;

      resolveFirst({ id: 7, username: "tester" });
      assert.equal((await firstRequest).status, 200);
      assert.equal(diagnostics.validatedTokenCount(), 1);

      rejectSecond(tokenValidationError(status));
      assert.equal((await secondRequest).status, status);
      assert.equal(diagnostics.validatedTokenCount(), 0);
      assert.equal(
        diagnostics.authenticationFailureKeyCount(),
        status === 401 ? 1 : 0,
      );

      assert.equal(
        (await requestTools(state.baseUrl, "shared-token")).status,
        200,
      );
      assert.equal(validationCalls, 3);
      assert.equal(diagnostics.validationBudgetCount(), 3);
    });
  }
});

test("bounds and expires validated bearer-token cache entries", async (t) => {
  let validationCalls = 0;
  let currentTime = 1_000;
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidationMaxEntries: 2,
    tokenValidationTtlMs: 100,
    now: () => currentTime,
    tokenValidator: async ({ token }) => {
      validationCalls += 1;
      return { id: validationCalls, username: token };
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  for (const token of ["one", "two", "three"]) {
    assert.equal((await requestTools(state.baseUrl, token)).status, 200);
  }
  assert.equal(diagnostics.validatedTokenCount(), 2);

  assert.equal((await requestTools(state.baseUrl, "one")).status, 200);
  assert.equal(validationCalls, 4);
  assert.equal(diagnostics.validatedTokenCount(), 2);

  currentTime += 101;
  assert.equal((await requestTools(state.baseUrl, "four")).status, 200);
  assert.equal(diagnostics.validatedTokenCount(), 1);
});

test("rate-limits repeated rejected bearer tokens per credential", async (t) => {
  // Failures are tracked per token hash, so the same rejected token hits
  // the limit while different tokens remain unaffected.
  let validationCalls = 0;
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 2,
    authFailureWindowMs: 60_000,
    tokenValidator: async () => {
      validationCalls += 1;
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Same token rejected twice hits the limit.
  assert.equal((await requestTools(state.baseUrl, "bad-one")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "bad-one")).status, 401);
  const limited = await requestTools(state.baseUrl, "bad-one");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(validationCalls, 2);

  // A different token is not affected by the first token's failures.
  assert.equal((await requestTools(state.baseUrl, "bad-two")).status, 401);
  assert.equal(validationCalls, 3);
});

test("allows cached valid identities while rejecting new tokens at the limit", async (t) => {
  let validationCalls = 0;
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 2,
    tokenValidator: async ({ token }) => {
      validationCalls += 1;
      if (token === "good") {
        return { id: 7, username: "tester" };
      }
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Cached valid token succeeds without re-validation.
  assert.equal((await requestTools(state.baseUrl, "good")).status, 200);
  // Same bad token rejected twice hits the per-token limit.
  assert.equal((await requestTools(state.baseUrl, "bad-one")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "bad-one")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "bad-one")).status, 429);
  // Cached good token still succeeds.
  assert.equal((await requestTools(state.baseUrl, "good")).status, 200);
  // A different new token is NOT blocked by bad-one's failures.
  assert.equal((await requestTools(state.baseUrl, "new-token")).status, 401);
  assert.equal(validationCalls, 4);
});

test("isolates failure counters between different tokens from the same source", async (t) => {
  // Behind a reverse proxy every client shares one IP.  This test verifies
  // that one bad token's failures do not throttle a different token.
  let validationCalls = 0;
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 3,
    tokenValidator: async ({ token }) => {
      validationCalls += 1;
      if (token === "valid-token") {
        return { id: 7, username: "tester" };
      }
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Exhaust the failure limit for "attacker-token".
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (await requestTools(state.baseUrl, "attacker-token")).status,
      401,
    );
  }
  // "attacker-token" is now throttled.
  assert.equal(
    (await requestTools(state.baseUrl, "attacker-token")).status,
    429,
  );

  // A legitimate token from the same source is unaffected.
  assert.equal((await requestTools(state.baseUrl, "valid-token")).status, 200);
  assert.equal(validationCalls, 4);
});

test("rejects excess concurrent requests before body parsing", async (t) => {
  // Verify that the concurrency admission gate fires before the bounded
  // body parser consumes request bytes, preventing unauthenticated memory
  // pressure when the server is at capacity.
  let validationStarted;
  const started = new Promise((resolve) => {
    validationStarted = resolve;
  });
  let releaseValidation;
  const validationGate = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    maxConcurrentRequests: 1,
    tokenValidator: async () => {
      validationStarted();
      await validationGate;
      return { id: 7, username: "tester" };
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const first = requestTools(state.baseUrl, "first-token");
  await started;
  assert.equal(diagnostics.activeRequestCount(), 1);

  // Second request with a body should be rejected at the admission gate
  // before the body parser reads any bytes.
  const limited = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer second-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ padding: "x".repeat(128 * 1024) }),
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");

  releaseValidation();
  assert.equal((await first).status, 200);
  assert.equal(diagnostics.activeRequestCount(), 0);
});

test("rejects excess concurrent MCP requests before GitLab validation", async (t) => {
  let validationStarted;
  const started = new Promise((resolve) => {
    validationStarted = resolve;
  });
  let releaseValidation;
  const validationGate = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    maxConcurrentRequests: 1,
    tokenValidator: async () => {
      validationStarted();
      await validationGate;
      return { id: 7, username: "tester" };
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const first = requestTools(state.baseUrl, "first-token");
  await started;
  assert.equal(diagnostics.activeRequestCount(), 1);
  const limited = await requestTools(state.baseUrl, "second-token");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");

  releaseValidation();
  assert.equal((await first).status, 200);
  assert.equal(diagnostics.activeRequestCount(), 0);
});

test("limits concurrent MCP requests for one GitLab identity", async (t) => {
  let toolStarted;
  const started = new Promise((resolve) => {
    toolStarted = resolve;
  });
  let releaseTool;
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  const serverFactory = () => {
    const server = new McpServer({
      name: "concurrency-test",
      version: "1.0.0",
    });
    server.registerTool(
      "wait",
      {
        description: "Wait until the test releases the request.",
        inputSchema: {},
      },
      async () => {
        toolStarted();
        await toolGate;
        return { content: [{ type: "text", text: "done" }] };
      },
    );
    return server;
  };
  const { app } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    maxConcurrentRequests: 3,
    maxConcurrentRequestsPerIdentity: 1,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
    serverFactory,
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const first = requestMcp(state.baseUrl, "first-token", "tools/call", {
    name: "wait",
    arguments: {},
  });
  await started;
  const limited = await requestTools(state.baseUrl, "second-token");
  assert.equal(limited.status, 429);

  releaseTool();
  assert.equal((await first).status, 200);
  assert.equal((await requestTools(state.baseUrl, "second-token")).status, 200);
});

test("requires an allowlist for IPv4 and IPv6 wildcard bindings", () => {
  for (const host of ["0.0.0.0", "::"]) {
    assert.throws(
      () =>
        createHttpApp({
          host,
          allowedHosts: undefined,
        }),
      new RegExp(
        `MCP_ALLOWED_HOSTS is required when MCP_HOST is ${host.replaceAll(".", "\\.")}`,
      ),
    );
  }
});

test("accepts allowlisted wildcard and unconfigured loopback bindings", () => {
  for (const host of ["0.0.0.0", "::"]) {
    assert.doesNotThrow(() =>
      createHttpApp({
        host,
        allowedHosts: ["mcp.example.com"],
      }),
    );
  }
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.doesNotThrow(() =>
      createHttpApp({
        host,
        allowedHosts: undefined,
      }),
    );
  }
});

test("accepts legitimate MCP requests above Express's default JSON limit", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {
        _meta: {
          padding: "x".repeat(256 * 1024),
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools.length, 175);
});

test("rejects requests above the configured bounded MCP body limit", async (t) => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    requestBodyLimitBytes: 64 * 1024,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const response = await fetch(`${state.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ padding: "x".repeat(128 * 1024) }),
  });

  assert.equal(response.status, 413);
});

test("validates MCP request body limit configuration", () => {
  assert.equal(parseRequestBodyLimit(undefined), DEFAULT_MCP_REQUEST_BYTES);
  assert.equal(parseRequestBodyLimit("1048576"), 1_048_576);
  assert.throws(() => parseRequestBodyLimit("65535"), /must be an integer/);
  assert.throws(
    () => parseRequestBodyLimit(String(MAX_MCP_REQUEST_BYTES + 1)),
    /must be an integer/,
  );
  assert.throws(
    () => createHttpApp({ tokenValidationMaxEntries: 0 }),
    /MCP_TOKEN_CACHE_MAX_ENTRIES/,
  );
  assert.throws(
    () => createHttpApp({ maxConcurrentRequests: 0 }),
    /MCP_MAX_CONCURRENT_REQUESTS/,
  );
});

test("exposes a readiness promise and bounded graceful HTTP shutdown", async () => {
  const { app } = createHttpApp({
    host: "127.0.0.1",
    port: MIN_PORT,
    gitlabUrl: "https://gitlab.example.com",
  });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  assert.equal(httpServer.listening, true);
  await shutdownHttpServer(httpServer, { timeoutMs: 1_000 });
  assert.equal(httpServer.listening, false);
});

test("forces shutdown after the configured drain timeout", async () => {
  const calls = [];
  const fakeServer = {
    close() {},
    closeIdleConnections() {
      calls.push("idle");
    },
    closeAllConnections() {
      calls.push("all");
    },
  };
  await shutdownHttpServer(fakeServer, { timeoutMs: 5 });
  assert.deepEqual(calls, ["idle", "all"]);
});

test("validates PORT configuration", () => {
  // Default returns 3000 when no value is provided.
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort(""), 3000);

  // Empty PORT falls back to MCP_PORT via || semantics.
  const savedPort = process.env.PORT;
  const savedMcpPort = process.env.MCP_PORT;
  try {
    process.env.PORT = "";
    process.env.MCP_PORT = "4000";
    assert.equal(parsePort(), 4000);
    delete process.env.PORT;
    assert.equal(parsePort(), 4000);
    process.env.PORT = "5000";
    assert.equal(parsePort(), 5000);
  } finally {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedMcpPort === undefined) delete process.env.MCP_PORT;
    else process.env.MCP_PORT = savedMcpPort;
  }

  // Valid port values.
  assert.equal(parsePort("1"), MIN_PORT);
  assert.equal(parsePort("8080"), 8080);
  assert.equal(parsePort("65535"), MAX_PORT);
  assert.equal(parsePort(3000), 3000);

  // Zero, negative, fractional, non-numeric, and out-of-range values fail.
  assert.throws(() => parsePort("0"), /PORT must be an integer/);
  assert.throws(() => parsePort("-1"), /PORT must be an integer/);
  assert.throws(() => parsePort("3.5"), /PORT must be an integer/);
  assert.throws(() => parsePort("abc"), /PORT must be an integer/);
  assert.throws(() => parsePort("65536"), /PORT must be an integer/);
  assert.throws(
    () => parsePort(String(MAX_PORT + 1)),
    /PORT must be an integer/,
  );
  assert.throws(() => parsePort(NaN), /PORT must be an integer/);
  assert.throws(() => parsePort(Infinity), /PORT must be an integer/);
});

test("createHttpApp rejects invalid port values", () => {
  assert.throws(() => createHttpApp({ port: 0 }), /PORT must be an integer/);
  assert.throws(() => createHttpApp({ port: NaN }), /PORT must be an integer/);
  assert.throws(() => createHttpApp({ port: -1 }), /PORT must be an integer/);
  assert.throws(
    () => createHttpApp({ port: 65536 }),
    /PORT must be an integer/,
  );
  assert.throws(() => createHttpApp({ port: 3.5 }), /PORT must be an integer/);
});

test("createHttpApp accepts valid port values", () => {
  assert.doesNotThrow(() =>
    createHttpApp({ port: 1, gitlabUrl: "https://gitlab.example.com" }),
  );
  assert.doesNotThrow(() =>
    createHttpApp({ port: 8080, gitlabUrl: "https://gitlab.example.com" }),
  );
  assert.doesNotThrow(() =>
    createHttpApp({ port: 65535, gitlabUrl: "https://gitlab.example.com" }),
  );
});

test("caps unique-token rotation with an aggregate validation budget", async (t) => {
  // An attacker rotating through many distinct invalid tokens should be
  // stopped by the aggregate validation budget before each token reaches
  // the per-token failure limiter.
  let validationCalls = 0;
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authFailureLimit: 100,
    authValidationLimit: 3,
    authValidationWindowMs: 60_000,
    tokenValidator: async () => {
      validationCalls += 1;
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // First three distinct invalid tokens are validated upstream.
  assert.equal(
    (await requestTools(state.baseUrl, "attacker-token-1")).status,
    401,
  );
  assert.equal(
    (await requestTools(state.baseUrl, "attacker-token-2")).status,
    401,
  );
  assert.equal(
    (await requestTools(state.baseUrl, "attacker-token-3")).status,
    401,
  );
  assert.equal(validationCalls, 3);
  assert.equal(diagnostics.validationBudgetCount(), 3);

  // Fourth distinct token hits the aggregate budget — 429 before GitLab call.
  const blocked = await requestTools(state.baseUrl, "attacker-token-4");
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter >= 59 && retryAfter <= 60, `retry-after=${retryAfter}`);
  assert.match(blocked.headers.get("content-type"), /application\/json/);
  const body = await blocked.json();
  assert.equal(body.error, "too_many_requests");
  assert.match(body.message, /validation rate limit/i);
  // No additional validation call for the blocked token.
  assert.equal(validationCalls, 3);
});

test("allows cached valid identities to bypass the aggregate validation budget", async (t) => {
  let validationCalls = 0;
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authValidationLimit: 3,
    authValidationWindowMs: 60_000,
    tokenValidator: async ({ token }) => {
      validationCalls += 1;
      if (token === "good") {
        return { id: 7, username: "tester" };
      }
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Valid token succeeds and is cached (1 validation call).
  assert.equal((await requestTools(state.baseUrl, "good")).status, 200);
  assert.equal(validationCalls, 1);

  // Two distinct invalid tokens consume the remaining budget (3 total calls).
  assert.equal((await requestTools(state.baseUrl, "bad-1")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "bad-2")).status, 401);
  assert.equal(validationCalls, 3);
  assert.equal(diagnostics.validationBudgetCount(), 3);

  // A third invalid token is blocked by the aggregate budget.
  assert.equal((await requestTools(state.baseUrl, "bad-3")).status, 429);
  assert.equal(validationCalls, 3);

  // Cached valid token still succeeds without consuming budget.
  assert.equal((await requestTools(state.baseUrl, "good")).status, 200);
  assert.equal(validationCalls, 3);
});

test("recovers after the aggregate validation budget window expires", async (t) => {
  let currentTime = 1_000;
  let validationCalls = 0;
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    authValidationLimit: 2,
    authValidationWindowMs: 1_000,
    now: () => currentTime,
    tokenValidator: async () => {
      validationCalls += 1;
      throw tokenValidationError(401);
    },
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Exhaust the budget.
  assert.equal((await requestTools(state.baseUrl, "tok-a")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "tok-b")).status, 401);
  assert.equal((await requestTools(state.baseUrl, "tok-c")).status, 429);
  assert.equal(validationCalls, 2);

  // Advance time past the window.
  currentTime += 1_001;

  // Budget resets — new token is allowed.
  assert.equal((await requestTools(state.baseUrl, "tok-d")).status, 401);
  assert.equal(validationCalls, 3);
  assert.equal(diagnostics.validationBudgetCount(), 1);
});

test("validates MCP_AUTH_VALIDATION_LIMIT and MCP_AUTH_VALIDATION_WINDOW_MS configuration", () => {
  assert.throws(
    () => createHttpApp({ authValidationLimit: 0 }),
    /MCP_AUTH_VALIDATION_LIMIT/,
  );
  assert.throws(
    () => createHttpApp({ authValidationLimit: -1 }),
    /MCP_AUTH_VALIDATION_LIMIT/,
  );
  assert.throws(
    () => createHttpApp({ authValidationWindowMs: 0 }),
    /MCP_AUTH_VALIDATION_WINDOW_MS/,
  );
  assert.throws(
    () => createHttpApp({ authValidationWindowMs: -1 }),
    /MCP_AUTH_VALIDATION_WINDOW_MS/,
  );
  assert.doesNotThrow(() =>
    createHttpApp({
      authValidationLimit: 10,
      authValidationWindowMs: 30_000,
    }),
  );
});

test("rejects MCP request body reads that stall beyond the read timeout", async (t) => {
  // A client that sends headers but then stalls body upload should be
  // timed out and the concurrency slot must be released.
  const observed = [];
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    maxConcurrentRequests: 2,
    requestBodyReadTimeoutMs: 1_000,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
    requestObserver: (event) => observed.push(event),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  // Use raw http.request to send a partial body that stalls.
  const stalledResponse = await new Promise((resolve, reject) => {
    const port = state.server.address().port;
    let watchdog;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer stalled-token",
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        clearTimeout(watchdog);
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: JSON.parse(body),
            connection: res.headers.connection,
          });
        });
      },
    );
    req.on("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    // Send a partial body — never call req.end() so the body stalls.
    req.write('{"jsonrpc":"2.0",');
    watchdog = setTimeout(() => {
      req.destroy();
      reject(new Error("stalled request exceeded the timeout watchdog"));
    }, 2_500);
  });

  // Preserve the sanitized timeout response, then close the connection so the
  // unread body cannot be reused on a keep-alive socket.
  assert.equal(stalledResponse.status, 408);
  assert.equal(stalledResponse.body.error.code, -32001);
  assert.match(stalledResponse.body.error.message, /timed out/);
  assert.equal(stalledResponse.connection, "close");

  // The concurrency slot must have been released exactly once, and the normal
  // HTTP completion observer must retain visibility into timeout rejections.
  assert.equal(diagnostics.activeRequestCount(), 0);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].status, 408);
});

test("absolute body read deadline terminates trickle uploads and releases admission", async (t) => {
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    maxConcurrentRequests: 1,
    requestBodyReadTimeoutMs: 1_000,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const trickle = new Promise((resolve, reject) => {
    let interval;
    let watchdog;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: state.server.address().port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer trickle-token",
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        clearInterval(interval);
        clearTimeout(watchdog);
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(body),
            connection: res.headers.connection,
          }),
        );
      },
    );
    req.on("error", (error) => {
      clearInterval(interval);
      clearTimeout(watchdog);
      reject(error);
    });
    req.write('{"jsonrpc":"2.0",');
    interval = setInterval(() => req.write('"x":1,'), 200);
    watchdog = setTimeout(() => {
      clearInterval(interval);
      req.destroy();
      reject(new Error("trickle upload exceeded the timeout watchdog"));
    }, 2_500);
    req.on("close", () => {
      clearInterval(interval);
      clearTimeout(watchdog);
    });
  });

  const admissionWaitStartedAt = Date.now();
  while (
    diagnostics.activeRequestCount() !== 1 &&
    Date.now() - admissionWaitStartedAt < 750
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(diagnostics.activeRequestCount(), 1);

  // With the sole global slot occupied by the trickle upload, a complete
  // request must be rejected before body parsing/authentication. The same
  // request succeeds once the absolute deadline releases the slot.
  const limited = await requestTools(state.baseUrl, "blocked-token");
  assert.equal(limited.status, 429);
  assert.equal(diagnostics.activeRequestCount(), 1);

  const trickleResult = await trickle;
  assert.equal(trickleResult.status, 408);
  assert.equal(trickleResult.body.error.code, -32001);
  assert.equal(trickleResult.connection, "close");

  assert.equal(diagnostics.activeRequestCount(), 0);
  assert.equal((await requestTools(state.baseUrl, "normal-token")).status, 200);
});

test("accepts a valid multi-chunk body that completes within the absolute deadline", async (t) => {
  const { app, diagnostics } = createHttpApp({
    host: "127.0.0.1",
    publicUrl: "https://mcp.example.com/mcp",
    gitlabUrl: "https://gitlab.example.com",
    requestBodyReadTimeoutMs: 1_000,
    tokenValidator: async () => ({ id: 7, username: "tester" }),
  });
  const state = await listen(app);
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const midpoint = Math.floor(payload.length / 2);

  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: state.server.address().port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer multi-chunk-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload.slice(0, midpoint));
    setTimeout(() => req.end(payload.slice(midpoint)), 250);
  });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.result?.tools));
  assert.equal(diagnostics.activeRequestCount(), 0);
});

test("validates requestBodyReadTimeoutMs configuration", () => {
  assert.equal(
    createHttpApp({
      requestBodyReadTimeoutMs: DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS,
    }).diagnostics.activeRequestCount(),
    0,
  );
  assert.doesNotThrow(() => createHttpApp({ requestBodyReadTimeoutMs: 1_000 }));
  assert.doesNotThrow(() =>
    createHttpApp({
      requestBodyReadTimeoutMs: MAX_REQUEST_BODY_READ_TIMEOUT_MS,
    }),
  );
  assert.throws(
    () => createHttpApp({ requestBodyReadTimeoutMs: 0 }),
    /requestBodyReadTimeoutMs/,
  );
  assert.throws(
    () => createHttpApp({ requestBodyReadTimeoutMs: 999 }),
    /requestBodyReadTimeoutMs/,
  );
  assert.throws(
    () =>
      createHttpApp({
        requestBodyReadTimeoutMs: MAX_REQUEST_BODY_READ_TIMEOUT_MS + 1,
      }),
    /requestBodyReadTimeoutMs/,
  );
});

test("readiness rejects a single oversized chunk without buffering past the byte limit", async (t) => {
  // A mock server that sends a single JSON chunk larger than
  // READINESS_PROBE_MAX_BYTES (4096) in a valid 200 response.
  const oversized = "x".repeat(8192);
  const state = await listenRaw((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: oversized }));
  });
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);
});

test("readiness rejects multi-chunk overflow that exceeds the byte limit", async (t) => {
  // A mock server that sends valid JSON across multiple chunks but
  // whose combined size exceeds READINESS_PROBE_MAX_BYTES (4096).
  const state = await listenRaw((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("transfer-encoding", "chunked");
    const payload = JSON.stringify({
      data: "x".repeat(4096),
    });
    // Split into two chunks: first fits, second causes overflow.
    const mid = 2048;
    res.write(payload.slice(0, mid));
    res.end(payload.slice(mid));
  });
  t.after(() => new Promise((resolve) => state.server.close(resolve)));

  assert.equal(await checkGitLabReadiness({ gitlabUrl: state.baseUrl }), false);
});
