import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCandidateDeployment,
  fetchCandidateJson,
} from "../scripts/check-mcp-candidate.mjs";

test("candidate deployment check validates the private boundary endpoints", async () => {
  const publicUrl = "https://mcp.example.com/mcp";
  const requests = [];
  const responses = new Map([
    [
      "/.well-known/oauth-protected-resource",
      {
        resource: publicUrl,
        authorization_servers: ["https://gitlab.example.com"],
        scopes_supported: ["api"],
      },
    ],
    ["/health", { status: "ok", service: "gitlab-mcp" }],
    ["/ready", { status: "ready", service: "gitlab-mcp" }],
  ]);

  const result = await checkCandidateDeployment(
    "http://mcp.example.com:49152/mcp",
    publicUrl,
    {
      async fetchJsonFn(url) {
        requests.push(url.toString());
        return responses.get(url.pathname);
      },
    },
  );

  assert.deepEqual(requests, [
    "http://mcp.example.com:49152/.well-known/oauth-protected-resource",
    "http://mcp.example.com:49152/health",
    "http://mcp.example.com:49152/ready",
  ]);
  assert.deepEqual(result, {
    ready: true,
    resource: publicUrl,
    issues: [],
  });
});

test("candidate deployment check rejects unsafe candidate URLs before fetching", async () => {
  for (const candidateUrl of [
    "https://mcp.example.com/mcp",
    "http://mcp.example.com/not-mcp",
  ]) {
    let fetched = false;
    await assert.rejects(
      checkCandidateDeployment(candidateUrl, "https://mcp.example.com/mcp", {
        fetchJsonFn() {
          fetched = true;
          assert.fail("invalid candidate URL must fail before endpoint access");
        },
      }),
      /Candidate URL must be private HTTP and end in \/mcp\./u,
    );
    assert.equal(fetched, false);
  }

  await assert.rejects(
    checkCandidateDeployment("", "https://mcp.example.com/mcp"),
    /Pass the private candidate MCP URL and expected public MCP URL\./u,
  );
});

test("candidate JSON fetch is bounded and rejects non-success responses", async () => {
  const signal = {};
  let request;
  const payload = { status: "ok" };
  const result = await fetchCandidateJson(new URL("http://candidate/health"), {
    async fetchImpl(url, options) {
      request = { url: url.toString(), options };
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
    createTimeoutSignal(timeoutMs) {
      assert.equal(timeoutMs, 10_000);
      return signal;
    },
  });

  assert.deepEqual(result, payload);
  assert.deepEqual(request, {
    url: "http://candidate/health",
    options: {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal,
    },
  });

  await assert.rejects(
    fetchCandidateJson(new URL("http://candidate/ready"), {
      async fetchImpl() {
        return {
          ok: false,
          status: 503,
          async json() {
            assert.fail("non-success responses must not be parsed");
          },
        };
      },
      createTimeoutSignal() {
        return signal;
      },
    }),
    /\/ready returned HTTP 503\./u,
  );
});
