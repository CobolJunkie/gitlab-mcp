import assert from "node:assert/strict";
import test from "node:test";

import {
  GitLabApiError,
  GitLabClient,
  normalizeGitLabUrl,
  projectApiPath,
} from "../src/gitlab-client.mjs";
import { SERVER_VERSION } from "../src/version.mjs";

test("normalizes GitLab instance URLs", () => {
  assert.equal(
    normalizeGitLabUrl("https://gitlab.example.com/"),
    "https://gitlab.example.com",
  );
  assert.equal(
    normalizeGitLabUrl("https://gitlab.example.com/api/v4"),
    "https://gitlab.example.com",
  );
  assert.throws(
    () => normalizeGitLabUrl("file:///tmp/gitlab"),
    /http or https/,
  );
  assert.throws(
    () => normalizeGitLabUrl("http://gitlab.example.com"),
    /must use HTTPS/,
  );
  assert.equal(
    normalizeGitLabUrl("http://127.0.0.1:8080/gitlab", {
      allowInsecureHttp: true,
    }),
    "http://127.0.0.1:8080/gitlab",
  );
  assert.equal(
    normalizeGitLabUrl("http://198.51.100.10/gitlab", {
      allowInsecureHttp: true,
    }),
    "http://198.51.100.10/gitlab",
  );
  assert.equal(
    normalizeGitLabUrl("http://gitlab.example.test", {
      allowInsecureHttp: true,
    }),
    "http://gitlab.example.test",
  );
  assert.equal(
    normalizeGitLabUrl("http://gitlab", {
      allowInsecureHttp: true,
    }),
    "http://gitlab",
  );
  assert.throws(
    () =>
      normalizeGitLabUrl("http://gitlab.example.com", {
        allowInsecureHttp: true,
      }),
    /permitted only outside production/,
  );
  assert.throws(
    () =>
      normalizeGitLabUrl("http://198.51.100.10", {
        allowInsecureHttp: true,
        production: true,
      }),
    /permitted only outside production/,
  );
  assert.throws(
    () =>
      normalizeGitLabUrl("http://0.0.0.0", {
        allowInsecureHttp: true,
      }),
    /permitted only outside production/,
  );
  assert.throws(
    () => normalizeGitLabUrl("https://user:pass@gitlab.example.com"),
    /embedded credentials/,
  );
  assert.throws(
    () => normalizeGitLabUrl("https://gitlab.example.com/?debug=1"),
    /query or fragment/,
  );
});

test("encodes project paths as a single GitLab API segment", () => {
  assert.equal(
    projectApiPath("group/subgroup/project"),
    "/projects/group%2Fsubgroup%2Fproject",
  );
  assert.equal(projectApiPath(42), "/projects/42");
});

test("sends bearer auth, query arrays, JSON body, and pagination", async () => {
  let captured;
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
    fetchImpl: async (url, init) => {
      captured = { url: url.toString(), init };
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-page": "2",
          "x-per-page": "20",
          "x-next-page": "3",
          "x-total": "50",
          "x-total-pages": "3",
        },
      });
    },
  });

  const result = await client.request("/projects", {
    method: "POST",
    query: { "labels[]": ["bug", "backend"], page: 2 },
    body: { title: "Example" },
  });

  const url = new URL(captured.url);
  assert.equal(url.pathname, "/api/v4/projects");
  assert.deepEqual(url.searchParams.getAll("labels[]"), ["bug", "backend"]);
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(captured.init.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(captured.init.body), { title: "Example" });
  assert.deepEqual(result.data, [{ id: 1 }]);
  assert.deepEqual(result.pagination, {
    page: 2,
    perPage: 20,
    nextPage: 3,
    previousPage: undefined,
    total: 50,
    totalPages: 3,
  });
});

test("sends GitLab access tokens with the PRIVATE-TOKEN header", async () => {
  let captured;
  const client = new GitLabClient({
    token: "glpat-example-token",
    fetchImpl: async (_url, init) => {
      captured = init;
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    },
  });

  await client.request("/user");

  assert.equal(captured.headers["PRIVATE-TOKEN"], "glpat-example-token");
  assert.equal(captured.headers.Authorization, undefined);
});

test("retries access tokens as bearer credentials after a PRIVATE-TOKEN 401", async () => {
  const requests = [];
  const client = new GitLabClient({
    token: "glpat-example-token",
    fetchImpl: async (_url, init) => {
      requests.push(init);
      if (requests.length === 1) {
        return new Response(JSON.stringify({ message: "401 Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    },
  });

  await client.request("/projects/example");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["PRIVATE-TOKEN"], "glpat-example-token");
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[1].headers["PRIVATE-TOKEN"], undefined);
  assert.equal(requests[1].headers.Authorization, "Bearer glpat-example-token");
});

test("normalizes GitLab API failures without leaking tokens", async () => {
  const client = new GitLabClient({
    token: "do-not-leak",
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "404 Project Not Found" }), {
        status: 404,
        statusText: "Not Found",
      }),
  });

  await assert.rejects(client.request("/projects/missing"), (error) => {
    assert.ok(error instanceof GitLabApiError);
    assert.equal(error.status, 404);
    assert.equal(error.path, "/projects/missing");
    assert.doesNotMatch(JSON.stringify(error.toJSON()), /do-not-leak/);
    return true;
  });
});

test("rejects oversized text responses", async () => {
  const client = new GitLabClient({
    token: "token",
    maxTextBytes: 8,
    fetchImpl: async () =>
      new Response("0123456789", {
        status: 200,
      }),
  });

  await assert.rejects(
    client.request("/jobs/1/trace", { responseType: "text" }),
    /safety limit/,
  );
});

test("rejects oversized JSON responses without a content-length header", async () => {
  const client = new GitLabClient({
    token: "token",
    maxTextBytes: 8,
    fetchImpl: async () =>
      new Response('{"value":"0123456789"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(client.request("/projects"), /JSON response exceeds/);
});

test("stops reading a chunked response when the byte limit is exceeded", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("0123"));
      controller.enqueue(new TextEncoder().encode("456789"));
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new GitLabClient({
    token: "token",
    maxTextBytes: 8,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  await assert.rejects(
    client.request("/jobs/1/trace", { responseType: "text" }),
    /text response exceeds the 8-byte safety limit/,
  );
  assert.equal(canceled, true);
});

test("bounds oversized GitLab error response bodies", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(20_000)));
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response(body, { status: 500, statusText: "Internal Server Error" }),
  });

  await assert.rejects(client.request("/projects"), (error) => {
    assert.ok(error instanceof GitLabApiError);
    assert.equal(error.status, 500);
    assert.equal(error.response.truncated, true);
    assert.equal(error.response.preview.length, 16_384);
    return true;
  });
  assert.equal(canceled, true);
});

test("keeps the timeout active while consuming the response body", async () => {
  let canceled = false;
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new GitLabClient({
    token: "token",
    timeoutMs: 20,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  await assert.rejects(
    client.request("/jobs/1/trace", { responseType: "text" }),
    /timed out after 20 ms/,
  );
  assert.equal(canceled, true);
});

test("normalizes invalid successful JSON responses and preserves GET method", async () => {
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("{invalid", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(client.request("/projects"), (error) => {
    assert.ok(error instanceof GitLabApiError);
    assert.equal(error.method, "GET");
    assert.match(error.message, /invalid JSON response/);
    return true;
  });
});

test("preserves POST method in invalid JSON parse errors", async () => {
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("{invalid", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.request("/projects", { method: "POST", body: { title: "test" } }),
    (error) => {
      assert.ok(error instanceof GitLabApiError);
      assert.equal(error.method, "POST");
      return true;
    },
  );
});

test("preserves PUT method in invalid JSON parse errors", async () => {
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("{invalid", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.request("/projects/1", { method: "PUT", body: { name: "test" } }),
    (error) => {
      assert.ok(error instanceof GitLabApiError);
      assert.equal(error.method, "PUT");
      return true;
    },
  );
});

test("preserves PATCH method in invalid JSON parse errors", async () => {
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("{invalid", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.request("/projects/1", { method: "PATCH", body: { name: "test" } }),
    (error) => {
      assert.ok(error instanceof GitLabApiError);
      assert.equal(error.method, "PATCH");
      return true;
    },
  );
});

test("preserves DELETE method in invalid JSON parse errors", async () => {
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("{invalid", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.request("/projects/1", { method: "DELETE" }),
    (error) => {
      assert.ok(error instanceof GitLabApiError);
      assert.equal(error.method, "DELETE");
      return true;
    },
  );
});

test("request metadata meta object flows through all error paths", async () => {
  // Verify that the meta object provides consistent method/path in HTTP errors
  const client = new GitLabClient({
    token: "token",
    fetchImpl: async () =>
      new Response("error", {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.request("/projects", { method: "POST", body: { title: "test" } }),
    (error) => {
      assert.ok(error instanceof GitLabApiError);
      assert.equal(error.method, "POST");
      assert.equal(error.path, "/projects");
      assert.equal(error.status, 422);
      return true;
    },
  );
});

test("supports bounded same-origin GitLab attachment requests", async () => {
  let capturedUrl;
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    fetchImpl: async (url) => {
      capturedUrl = url.toString();
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    },
  });

  const result = await client.request(
    new URL(
      "https://gitlab.example.com/group/project/-/uploads/secret/image.png",
    ),
    { responseType: "binary", maxBytes: 1_000 },
  );

  assert.equal(
    capturedUrl,
    "https://gitlab.example.com/group/project/-/uploads/secret/image.png",
  );
  assert.deepEqual(result.data, {
    encoding: "base64",
    contentType: "image/png",
    contentLength: 3,
    content: "AQID",
  });
  await assert.rejects(
    client.request(
      new URL("https://attacker.example/uploads/secret/image.png"),
    ),
    /configured GitLab origin and path/,
  );
});

test("keeps absolute requests inside a self-managed GitLab URL prefix", async () => {
  const client = new GitLabClient({
    baseUrl: "https://example.com/gitlab",
    token: "token",
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });

  assert.equal(
    (
      await client.request(
        new URL("https://example.com/gitlab/group/project/-/raw/main/file.txt"),
        { responseType: "text" },
      )
    ).data,
    "ok",
  );
  await assert.rejects(
    client.request(
      new URL("https://example.com/other-app/-/raw/main/secret.txt"),
      { responseType: "text" },
    ),
    /configured GitLab origin and path/,
  );
});

test("User-Agent header uses the harness-neutral core identity", async () => {
  let capturedHeaders;
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "test-token",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers;
      return new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.request("/user");
  assert.equal(capturedHeaders["User-Agent"], `gitlab-mcp/${SERVER_VERSION}`);
});
