import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createHttpApp, validateGitLabBearerToken } from "../src/http.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("default bearer validation emits bounded logical GitLab request metrics", async (t) => {
  const gitlab = createServer((req, res) => {
    assert.equal(req.url, "/api/v4/user");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 7, username: "metric-user" }));
  });
  const gitlabUrl = await listen(gitlab);
  t.after(() => new Promise((resolve) => gitlab.close(resolve)));

  const events = [];
  const token = "private-validation-token";
  const identity = await validateGitLabBearerToken({
    gitlabUrl,
    token,
    allowInsecureHttp: true,
    observabilityObserver: (event) => events.push(event),
  });

  assert.deepEqual(identity, { id: 7, username: "metric-user" });
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
  assert.deepEqual(size.attributes, {
    method: "GET",
    outcome: "success",
    response_type: "json",
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("/user"), false);
  assert.equal(serialized.includes("metric-user"), false);
});

test("HTTP token validation forwards the observability observer to the validator", async (t) => {
  const events = [];
  const observer = (event) => events.push(event);
  let receivedObserver;
  const { app } = createHttpApp({
    host: "127.0.0.1",
    gitlabUrl: "https://gitlab.example.com",
    publicUrl: "http://127.0.0.1/mcp",
    allowInsecurePublicUrl: true,
    observabilityObserver: observer,
    tokenValidator: async ({ observabilityObserver }) => {
      receivedObserver = observabilityObserver;
      throw new GitLabApiError("rejected fixture token", {
        status: 401,
        method: "GET",
        path: "/user",
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer rejected-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.status, 401);
  assert.equal(receivedObserver, observer);
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.auth.validation.duration" &&
        event.attributes.outcome === "rejected",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.http.admission.rejections" &&
        event.attributes.reason === "invalid_token",
    ),
  );
});

test("HTTP token validation metrics distinguish insufficient scope", async (t) => {
  const events = [];
  const { app } = createHttpApp({
    host: "127.0.0.1",
    gitlabUrl: "https://gitlab.example.com",
    publicUrl: "http://127.0.0.1/mcp",
    allowInsecurePublicUrl: true,
    observabilityObserver: (event) => events.push(event),
    tokenValidator: async () => {
      throw new GitLabApiError("insufficient scope", {
        status: 403,
        method: "GET",
        path: "/user",
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer insufficient-scope-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.status, 403);
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.auth.validation.duration" &&
        event.attributes.outcome === "rejected",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.http.admission.rejections" &&
        event.attributes.reason === "insufficient_scope",
    ),
  );
});

test("HTTP token validation metrics distinguish transient upstream failures", async (t) => {
  const events = [];
  const { app } = createHttpApp({
    host: "127.0.0.1",
    gitlabUrl: "https://gitlab.example.com",
    publicUrl: "http://127.0.0.1/mcp",
    allowInsecurePublicUrl: true,
    observabilityObserver: (event) => events.push(event),
    tokenValidator: async () => {
      throw new GitLabApiError("upstream unavailable", {
        status: 503,
        method: "GET",
        path: "/user",
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer transient-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.status, 503);
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.auth.validation.duration" &&
        event.attributes.outcome === "error",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.metric === "gitlab_mcp.http.admission.rejections" &&
        event.attributes.reason === "token_validation_unavailable",
    ),
  );
});
