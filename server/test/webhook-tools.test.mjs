import assert from "node:assert/strict";
import test from "node:test";

import {
  isSecretHeader,
  redactHeaders,
  webhookMetadata,
  webhookEventMetadata,
} from "../src/tools/webhook-tools.mjs";

// ── isSecretHeader ─────────────────────────────────────────────────────────

test("isSecretHeader: exact match on SECRET_HEADER_KEYS", () => {
  assert.equal(isSecretHeader("token"), true);
  assert.equal(isSecretHeader("Token"), true);
  assert.equal(isSecretHeader("x-gitlab-token"), true);
  assert.equal(isSecretHeader("X-Gitlab-Token"), true);
  assert.equal(isSecretHeader("authorization"), true);
  assert.equal(isSecretHeader("Authorization"), true);
});

test("isSecretHeader: 'auth' substring catches X-Auth-Token and friends", () => {
  assert.equal(isSecretHeader("x-auth-token"), true);
  assert.equal(isSecretHeader("X-Auth-Token"), true);
  assert.equal(isSecretHeader("auth-token"), true);
  assert.equal(isSecretHeader("proxy-authentication"), true);
});

test("isSecretHeader: 'secret' substring catches custom secret headers", () => {
  assert.equal(isSecretHeader("x-custom-secret"), true);
  assert.equal(isSecretHeader("X-Custom-Secret"), true);
  assert.equal(isSecretHeader("my-secret-header"), true);
});

test("isSecretHeader: non-secret headers are not flagged", () => {
  assert.equal(isSecretHeader("content-type"), false);
  assert.equal(isSecretHeader("Content-Type"), false);
  assert.equal(isSecretHeader("accept"), false);
  assert.equal(isSecretHeader("x-request-id"), false);
  assert.equal(isSecretHeader("x-gitlab-event"), false);
  assert.equal(isSecretHeader("user-agent"), false);
  assert.equal(isSecretHeader("host"), false);
});

// ── redactHeaders ──────────────────────────────────────────────────────────

test("redactHeaders: null/undefined pass through", () => {
  assert.equal(redactHeaders(null), null);
  assert.equal(redactHeaders(undefined), undefined);
});

test("redactHeaders: non-object pass through", () => {
  assert.equal(redactHeaders("string"), "string");
  assert.equal(redactHeaders(42), 42);
});

test("redactHeaders: secret headers are redacted", () => {
  const input = {
    "content-type": "application/json",
    "x-gitlab-token": "s3cret",
    authorization: "Bearer abc123",
    "x-auth-token": "tok_123",
    "x-custom-secret": "shhh",
    "x-request-id": "req-456",
  };
  const result = redactHeaders(input);
  assert.equal(result["content-type"], "application/json");
  assert.equal(result["x-gitlab-token"], "[REDACTED]");
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result["x-auth-token"], "[REDACTED]");
  assert.equal(result["x-custom-secret"], "[REDACTED]");
  assert.equal(result["x-request-id"], "req-456");
});

test("redactHeaders: blanket mode redacts all values", () => {
  const input = {
    "content-type": "application/json",
    "x-api-key": "key_123",
    "x-webhook-key": "whsec_abc",
    "x-request-id": "req-456",
  };
  const result = redactHeaders(input, true);
  assert.equal(result["content-type"], "[REDACTED]");
  assert.equal(result["x-api-key"], "[REDACTED]");
  assert.equal(result["x-webhook-key"], "[REDACTED]");
  assert.equal(result["x-request-id"], "[REDACTED]");
  // Keys are preserved
  assert.deepEqual(Object.keys(result).sort(), [
    "content-type",
    "x-api-key",
    "x-request-id",
    "x-webhook-key",
  ]);
});

test("redactHeaders: preserves original object", () => {
  const input = { token: "secret" };
  const result = redactHeaders(input);
  assert.equal(result.token, "[REDACTED]");
  assert.equal(input.token, "secret"); // original unchanged
});

// ── webhookMetadata ────────────────────────────────────────────────────────

test("webhookMetadata: null/undefined pass through", () => {
  assert.equal(webhookMetadata(null), null);
  assert.equal(webhookMetadata(undefined), undefined);
  assert.equal(webhookMetadata(false), false);
});

test("webhookMetadata: strips token field", () => {
  const hook = {
    id: 1,
    url: "https://example.com/hook",
    token: "super-secret-token",
    push_events: true,
    custom_headers: {},
  };
  const result = webhookMetadata(hook);
  assert.equal(result.token, undefined);
  assert.equal(result.id, 1);
  assert.equal(result.url, "https://example.com/hook");
  assert.equal(result.push_events, true);
});

test("webhookMetadata: blanket-redacts ALL custom_headers values", () => {
  const hook = {
    id: 2,
    url: "https://example.com/hook",
    push_events: true,
    custom_headers: {
      "x-auth-token": "tok_abc",
      "content-type": "application/json",
      "x-custom-secret": "shhh",
      "x-api-key": "key_123",
      "x-webhook-key": "whsec_abc",
      "x-signature": "sig_456",
    },
  };
  const result = webhookMetadata(hook);
  // ALL custom header values are blanket-redacted because they are
  // operator-configured and may carry arbitrary credentials.
  assert.deepEqual(result.custom_headers, {
    "x-auth-token": "[REDACTED]",
    "content-type": "[REDACTED]",
    "x-custom-secret": "[REDACTED]",
    "x-api-key": "[REDACTED]",
    "x-webhook-key": "[REDACTED]",
    "x-signature": "[REDACTED]",
  });
});

test("webhookMetadata: custom_headers keys visible, values hidden", () => {
  const hook = {
    id: 3,
    url: "https://example.com/hook",
    push_events: true,
    custom_headers: { token: "secret", "x-api-key": "key" },
  };
  const result = webhookMetadata(hook);
  // All values blanket-redacted; keys retained so operators can see
  // which custom headers exist without learning their secrets.
  assert.deepEqual(result.custom_headers, {
    token: "[REDACTED]",
    "x-api-key": "[REDACTED]",
  });
});

test("webhookMetadata: omits custom_headers when input object is empty", () => {
  const hook = {
    id: 30,
    url: "https://example.com/hook",
    push_events: true,
    custom_headers: {},
  };
  const result = webhookMetadata(hook);
  assert.equal(result.custom_headers, undefined);
});

test("webhookMetadata: omits custom_headers when undefined on input", () => {
  const hook = {
    id: 4,
    url: "https://example.com/hook",
    push_events: true,
  };
  const result = webhookMetadata(hook);
  assert.equal(result.custom_headers, undefined);
});

test("webhookMetadata: returns only allowlisted fields", () => {
  const hook = {
    id: 5,
    url: "https://example.com",
    token: "secret",
    secret_token: "also-secret",
    custom_headers: { "x-auth-token": "tok" },
    push_events: true,
    push_events_branch_filter: "main",
    issues_events: false,
    confidential_issues_events: false,
    merge_requests_events: false,
    tag_push_events: false,
    note_events: false,
    confidential_note_events: false,
    job_events: false,
    pipeline_events: false,
    wiki_page_events: false,
    deployment_events: false,
    releases_events: false,
    subgroup_events: false,
    member_events: false,
    custom_events: false,
    enable_ssl_verification: true,
    created_at: "2025-01-01",
    description: "test hook",
    // Extra fields that should NOT be returned
    extra_field: "should not appear",
    another_extra: 42,
  };
  const result = webhookMetadata(hook);
  assert.equal(result.token, undefined);
  assert.equal(result.secret_token, undefined);
  assert.equal(result.extra_field, undefined);
  assert.equal(result.another_extra, undefined);
  assert.equal(result.id, 5);
  assert.equal(result.url, "https://example.com");
  assert.equal(result.push_events, true);
});

// ── webhookEventMetadata ───────────────────────────────────────────────────

test("webhookEventMetadata: null/undefined pass through", () => {
  assert.equal(webhookEventMetadata(null), null);
  assert.equal(webhookEventMetadata(undefined), undefined);
});

test("webhookEventMetadata: redacts request_headers secrets", () => {
  const event = {
    id: 1,
    trigger: "push_hooks",
    request_headers: {
      "x-gitlab-token": "s3cret",
      "content-type": "application/json",
      "x-auth-token": "tok_123",
      authorization: "Bearer abc",
    },
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  assert.equal(result.request_headers["x-gitlab-token"], "[REDACTED]");
  assert.equal(result.request_headers["content-type"], "application/json");
  assert.equal(result.request_headers["x-auth-token"], "[REDACTED]");
  assert.equal(result.request_headers.authorization, "[REDACTED]");
});

test("webhookEventMetadata: response_body absent from output, metadata present", () => {
  const event = { id: 2, response_body: "short body content" };
  const result = webhookEventMetadata(event);
  // Contents must never be exposed
  assert.equal(result.response_body, undefined);
  // Safe metadata retained
  assert.equal(result.response_body_present, true);
  assert.equal(result.response_body_length, 18);
});

test("webhookEventMetadata: long response_body absent from output, metadata present", () => {
  const longBody = "x".repeat(3000);
  const event = { id: 2, response_body: longBody };
  const result = webhookEventMetadata(event);
  // Contents must never be exposed regardless of length
  assert.equal(result.response_body, undefined);
  assert.equal(result.response_body_present, true);
  assert.equal(result.response_body_length, 3000);
});

test("webhookEventMetadata: response_body absent when input has no body", () => {
  const event = { id: 3 };
  const result = webhookEventMetadata(event);
  assert.equal(result.response_body, undefined);
  assert.equal(result.response_body_present, false);
  assert.equal(result.response_body_length, undefined);
});

test("webhookEventMetadata: response_body_present true for non-string body", () => {
  const event = { id: 4, response_body: 42 };
  const result = webhookEventMetadata(event);
  assert.equal(result.response_body, undefined);
  assert.equal(result.response_body_present, true);
  // Non-string body: length is not measured
  assert.equal(result.response_body_length, undefined);
});

test("webhookEventMetadata: redacts response_headers secrets", () => {
  const event = {
    id: 41,
    trigger: "push_hooks",
    response_headers: {
      "content-type": "application/json; charset=utf-8",
      "x-powered-by": "Express",
      "x-auth-token": "tok_secret",
      authorization: "Bearer abc",
      "x-custom-secret": "shhh",
    },
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  assert.equal(
    result.response_headers["content-type"],
    "application/json; charset=utf-8",
  );
  assert.equal(result.response_headers["x-powered-by"], "Express");
  assert.equal(result.response_headers["x-auth-token"], "[REDACTED]");
  assert.equal(result.response_headers.authorization, "[REDACTED]");
  assert.equal(result.response_headers["x-custom-secret"], "[REDACTED]");
});

test("webhookEventMetadata: response_headers omitted when empty or absent", () => {
  const event1 = { id: 42, trigger: "push_hooks", response_body: "OK" };
  assert.equal(webhookEventMetadata(event1).response_headers, undefined);

  const event2 = {
    id: 43,
    trigger: "push_hooks",
    response_headers: {},
    response_body: "OK",
  };
  assert.equal(webhookEventMetadata(event2).response_headers, undefined);
});

test("webhookEventMetadata: exposes execution_duration", () => {
  const event = {
    id: 44,
    trigger: "push_hooks",
    execution_duration: 1.090648,
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  assert.equal(result.execution_duration, 1.090648);
});

test("webhookEventMetadata: execution_duration undefined when absent", () => {
  const event = { id: 45, trigger: "push_hooks", response_body: "OK" };
  const result = webhookEventMetadata(event);
  assert.equal(result.execution_duration, undefined);
});

test("webhookEventMetadata: omits request_data", () => {
  const event = {
    id: 5,
    trigger: "push_hooks",
    request_data: '{"secret":"payload"}',
    request_headers: {},
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  assert.equal(result.request_data, undefined);
});

test("webhookEventMetadata: omits data field", () => {
  const event = {
    id: 6,
    trigger: "push_hooks",
    data: { before: "abc", after: "def", secret: "token" },
    request_headers: {},
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  assert.equal(result.data, undefined);
});

test("webhookEventMetadata: returns expected fields", () => {
  const event = {
    id: 7,
    trigger: "push_hooks",
    url: "https://example.com/hook",
    response_status: "200",
    request_headers: { "content-type": "application/json" },
    response_headers: { "content-type": "application/json; charset=utf-8" },
    request_data: "should be omitted",
    response_body: "OK",
    execution_duration: 1.5,
    data: "should also be omitted",
    created_at: "2025-01-01T00:00:00Z",
    retry_count: 0,
    extra_field: "not included",
  };
  const result = webhookEventMetadata(event);
  assert.deepEqual(Object.keys(result).sort(), [
    "execution_duration",
    "id",
    "request_headers",
    "response_body_length",
    "response_body_present",
    "response_headers",
    "response_status",
    "trigger",
    "url",
  ]);
});

// ── Canary-secret regression tests ────────────────────────────────────────
// These tests verify that sensitive values placed inside response_body
// never leak into MCP output, regardless of body length. Credential-shaped
// canaries are assembled at runtime so source scanning remains effective.

function syntheticCredential(...parts) {
  return parts.join("");
}

test("canary: short response_body secret never reaches MCP output", () => {
  const CANARY = syntheticCredential("gh", "p_", "a".repeat(36));
  const event = {
    id: 100,
    trigger: "push_hooks",
    response_status: "200",
    request_headers: { "content-type": "application/json" },
    response_headers: { "content-type": "application/json" },
    response_body: `Status: OK. Internal token: ${CANARY}. Build passed.`,
    execution_duration: 0.5,
  };
  const result = webhookEventMetadata(event);
  const json = JSON.stringify(result);

  // The canary secret must never appear in the structured output
  assert.doesNotMatch(
    json,
    new RegExp(CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  // response_body key must not exist at all
  assert.equal(result.response_body, undefined);
  // But metadata is retained
  assert.equal(result.response_body_present, true);
  assert.equal(typeof result.response_body_length, "number");
});

test("canary: long response_body secret never reaches MCP output", () => {
  const CANARY = syntheticCredential("sk", "-proj-", "a".repeat(48));
  const padding = "x".repeat(5000);
  const event = {
    id: 101,
    trigger: "push_hooks",
    response_status: "500",
    request_headers: { "content-type": "application/json" },
    response_body: `${padding}${CANARY}${padding}`,
    execution_duration: 2.1,
  };
  const result = webhookEventMetadata(event);
  const json = JSON.stringify(result);

  // The canary secret must never appear even in oversized bodies
  assert.doesNotMatch(
    json,
    new RegExp(CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(result.response_body, undefined);
  assert.equal(result.response_body_present, true);
  assert.equal(result.response_body_length, 5000 + CANARY.length + 5000);
});

test("canary: request payload body never reaches MCP output", () => {
  const CANARY = syntheticCredential("gh", "r_", "a".repeat(30));
  const event = {
    id: 102,
    trigger: "push_hooks",
    request_data: JSON.stringify({ secret: CANARY, project: "test" }),
    data: { token: CANARY },
    request_headers: { "content-type": "application/json" },
    response_body: "OK",
  };
  const result = webhookEventMetadata(event);
  const json = JSON.stringify(result);

  assert.doesNotMatch(
    json,
    new RegExp(CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(result.request_data, undefined);
  assert.equal(result.data, undefined);
});

test("canary: custom_header secret values blanket-redacted in webhook metadata", () => {
  const CANARY = syntheticCredential("wh", "sec_", "a".repeat(32));
  const hook = {
    id: 103,
    url: "https://example.com/hook",
    push_events: true,
    custom_headers: {
      "X-Webhook-Secret": CANARY,
      "X-Signature-Key": "sig_abcdef",
    },
  };
  const result = webhookMetadata(hook);
  const json = JSON.stringify(result);

  assert.doesNotMatch(
    json,
    new RegExp(CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(json, /sig_abcdef/);
  // Keys are still visible
  assert.deepEqual(result.custom_headers, {
    "X-Webhook-Secret": "[REDACTED]",
    "X-Signature-Key": "[REDACTED]",
  });
});

test("canary: GitLab-realistic push webhook event contains no secrets in output", () => {
  // Simulates a realistic GitLab webhook delivery event response
  const CANARY_SECRET = syntheticCredential("gl", "pat-", "a".repeat(20));
  const event = {
    id: 200,
    trigger: "push_hooks",
    url: "https://gitlab.example.com/api/v4/projects/123/hooks/456",
    response_status: "200",
    request_headers: {
      "content-type": "application/json",
      "x-gitlab-token": "webhook-secret-value",
      "x-gitlab-event": "Push Hook",
      "x-request-id": "req-abc123",
    },
    response_headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": "req-def456",
    },
    response_body: `{"status":"ok","message":"Webhook processed","internal_token":"${CANARY_SECRET}","processed_at":"2026-08-10T12:00:00Z"}`,
    request_data: JSON.stringify({
      object_kind: "push",
      ref: "refs/heads/main",
      project: { id: 123, name: "test-project" },
      secret_token: "request-side-secret",
    }),
    execution_duration: 0.342,
  };
  const result = webhookEventMetadata(event);
  const json = JSON.stringify(result);

  // No secrets in output
  assert.doesNotMatch(
    json,
    new RegExp(CANARY_SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(json, /webhook-secret-value/);
  assert.doesNotMatch(json, /request-side-secret/);
  assert.doesNotMatch(json, /internal_token/);

  // response_body absent
  assert.equal(result.response_body, undefined);

  // Safe metadata retained
  assert.equal(result.response_body_present, true);
  assert.equal(typeof result.response_body_length, "number");
  assert.equal(result.response_status, "200");
  assert.equal(result.execution_duration, 0.342);
  assert.equal(result.trigger, "push_hooks");

  // Headers sanitized
  assert.equal(result.request_headers["x-gitlab-token"], "[REDACTED]");
  assert.equal(result.request_headers["content-type"], "application/json");
  assert.equal(result.request_headers["x-gitlab-event"], "Push Hook");
  assert.equal(
    result.response_headers["content-type"],
    "text/plain; charset=utf-8",
  );
  assert.equal(result.response_headers["cache-control"], "no-cache");
});

test("canary: GitLab-realistic pipeline webhook event contains no secrets", () => {
  const CANARY = "ci-job-token-abc123def456";
  const event = {
    id: 201,
    trigger: "pipeline_hooks",
    url: "https://gitlab.example.com/api/v4/projects/456/hooks/789",
    response_status: "201",
    request_headers: {
      "content-type": "application/json",
      "x-gitlab-token": "pipeline-hook-token",
      "x-gitlab-event": "Pipeline Hook",
    },
    response_headers: {},
    response_body: `{"id":101,"status":"running","token":"${CANARY}"}`,
    request_data: JSON.stringify({
      object_kind: "pipeline",
      project: { id: 456, path_with_namespace: "group/project" },
      commit: { message: "feat: add feature" },
    }),
    execution_duration: 0.128,
  };
  const result = webhookEventMetadata(event);
  const json = JSON.stringify(result);

  assert.doesNotMatch(json, /ci-job-token-abc123def456/);
  assert.doesNotMatch(json, /pipeline-hook-token/);
  assert.equal(result.response_body, undefined);
  assert.equal(result.response_body_present, true);
});

// ── list_project_webhook_events route tests ────────────────────────────────

test("list_project_webhook_events: requires webhook_id in schema", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async () => ({ data: [] }),
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(
      (t) => t.name === "list_project_webhook_events",
    );
    assert.ok(tool, "list_project_webhook_events tool should exist");
    assert.ok(
      tool.inputSchema.required?.includes("webhook_id"),
      "webhook_id should be required",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_project_webhook_events: calls webhook-scoped events route", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        return {
          data: [
            {
              id: 1,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "OK",
            },
          ],
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({
      name: "list_project_webhook_events",
      arguments: {
        project: "group/project",
        webhook_id: 1,
        page: 2,
        per_page: 10,
      },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].path, /\/hooks\/1\/events/);
    // Must NOT match the invalid route without hook_id
    assert.doesNotMatch(calls[0].path, /\/hooks\/events/);
    assert.equal(calls[0].options?.query?.page, 2);
    assert.equal(calls[0].options?.query?.per_page, 10);
    // webhook_id must NOT appear in query string
    assert.equal(calls[0].options?.query?.webhook_id, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_project_webhook_events: forwards numeric status filter", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        return { data: [] };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({
      name: "list_project_webhook_events",
      arguments: { project: "group/project", webhook_id: 1, status: 200 },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.query?.status, 200);
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_project_webhook_events: forwards documented status-category filter", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        return { data: [] };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({
      name: "list_project_webhook_events",
      arguments: {
        project: "group/project",
        webhook_id: 1,
        status: "client_failure",
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.query?.status, "client_failure");
  } finally {
    await client.close();
    await server.close();
  }
});

// ── get_project_webhook_event route tests ──────────────────────────────────

test("get_project_webhook_event: requires webhook_id in schema", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async () => ({ data: [] }),
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(
      (t) => t.name === "get_project_webhook_event",
    );
    assert.ok(tool, "get_project_webhook_event tool should exist");
    assert.ok(
      tool.inputSchema.required?.includes("webhook_id"),
      "webhook_id should be required",
    );
    assert.ok(
      tool.inputSchema.required?.includes("event_id"),
      "event_id should be required",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: uses documented list endpoint, not undocumented direct GET", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        // Return the requested event on page 1
        return {
          data: [
            {
              id: 42,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "OK",
            },
          ],
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 42 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    // Must use the documented list endpoint scoped to webhook
    assert.match(calls[0].path, /\/hooks\/1\/events/);
    // Must NOT use any undocumented direct GET event endpoint
    assert.doesNotMatch(calls[0].path, /\/hooks\/events\/\d+/);
    assert.doesNotMatch(calls[0].path, /\/hooks\/1\/events\/\d+/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: returns immediately when event found on first page", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        return {
          data: [
            {
              id: 10,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "a",
            },
            {
              id: 42,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "b",
            },
            {
              id: 99,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "c",
            },
          ],
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 42 },
    });
    assert.equal(result.isError, undefined);
    // Should stop after first page — only 1 request
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: handles event on a later page", async () => {
  const calls = [];
  let pageCount = 0;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        pageCount++;
        if (pageCount === 1) {
          // Full page, event NOT here (ids 1001-1100)
          return {
            data: Array.from({ length: 100 }, (_, i) => ({
              id: 1001 + i,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "x",
            })),
          };
        }
        // Page 2: contains the target event
        return {
          data: [
            {
              id: 200,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "y",
            },
            {
              id: 42,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "z",
            },
          ],
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 42 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: stops when pagination exhausted", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        // Return fewer than 100 results → signals last page
        return {
          data: [
            {
              id: 1,
              trigger: "push_hooks",
              request_headers: {},
              response_body: "a",
            },
          ],
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 999 },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: respects bounded search limit of 10 pages", async () => {
  const calls = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options) => {
        calls.push({ path, options });
        // Always return a full page to force maximum pagination
        return {
          data: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            trigger: "push_hooks",
            request_headers: {},
            response_body: "x",
          })),
        };
      },
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 999999 },
    });
    assert.equal(result.isError, true);
    // Must not exceed 10 pages
    assert.equal(calls.length, 10);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_project_webhook_event: applies webhookEventMetadata sanitization", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { createGitLabMcpServer } = await import("../src/server.mjs");

  const CANARY = syntheticCredential("gh", "p_", "b".repeat(36));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async () => ({
        data: [
          {
            id: 42,
            trigger: "push_hooks",
            url: "https://example.com/hook",
            response_status: "200",
            request_headers: {
              "x-gitlab-token": "s3cret",
              "content-type": "text/plain",
            },
            response_headers: {
              "x-auth-token": "tok_secret",
              "content-type": "application/json",
            },
            response_body: `OK. Token: ${CANARY}. Done.`,
            execution_duration: 1.09,
            request_data: "should be stripped",
            data: { secret: "payload" },
          },
        ],
      }),
    }),
  });
  const client = new Client({ name: "webhook-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "get_project_webhook_event",
      arguments: { project: "group/project", webhook_id: 1, event_id: 42 },
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    // Canary secret must NEVER appear in MCP output
    assert.doesNotMatch(
      text,
      new RegExp(CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    // response_body content absent from output
    assert.equal(parsed.response_body, undefined);
    assert.equal(parsed.response_body_present, true);
    assert.equal(typeof parsed.response_body_length, "number");

    // Secrets redacted in request_headers
    assert.equal(parsed.request_headers["x-gitlab-token"], "[REDACTED]");
    // Secrets redacted in response_headers
    assert.equal(parsed.response_headers["x-auth-token"], "[REDACTED]");
    assert.equal(parsed.response_headers["content-type"], "application/json");
    // Sensitive fields omitted
    assert.equal(parsed.request_data, undefined);
    assert.equal(parsed.data, undefined);
    // Actual GitLab field names exposed
    assert.equal(parsed.trigger, "push_hooks");
    assert.equal(parsed.response_status, "200");
    assert.equal(parsed.execution_duration, 1.09);
    assert.equal(parsed.created_at, undefined);
    assert.equal(parsed.retry_count, undefined);
    assert.equal(parsed.event_type, undefined);
    assert.equal(parsed.status_code, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
