import assert from "node:assert/strict";
import test from "node:test";

import { auditMcpDeployment } from "../../scripts/check-mcp-deployment.mjs";

function deployment() {
  return {
    metadata: {
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://gitlab.example.com"],
      scopes_supported: ["api"],
    },
    health: { status: "ok", service: "gitlab-mcp" },
    ready: { status: "ready", service: "gitlab-mcp" },
  };
}

test("accepts a consistent HTTPS MCP deployment", () => {
  assert.deepEqual(
    auditMcpDeployment("https://mcp.example.com/mcp", deployment()),
    {
      ready: true,
      resource: "https://mcp.example.com/mcp",
      issues: [],
    },
  );
});

test("rejects unsafe or inconsistent MCP deployment metadata", () => {
  const state = deployment();
  state.metadata.resource = "https://other.example.com/mcp";
  state.metadata.authorization_servers = ["http://gitlab.example.test"];
  state.ready = { status: "unavailable", service: "gitlab-mcp" };

  const result = auditMcpDeployment("http://mcp.example.com/service", state);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((value) => /must use HTTPS/.test(value)));
  assert.ok(result.issues.some((value) => /path must end with/.test(value)));
  assert.ok(result.issues.some((value) => /exact MCP public URL/.test(value)));
  assert.ok(result.issues.some((value) => /authorization server/.test(value)));
  assert.ok(result.issues.some((value) => /readiness endpoint/.test(value)));
});
