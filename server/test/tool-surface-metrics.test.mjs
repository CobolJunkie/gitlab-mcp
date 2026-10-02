import assert from "node:assert/strict";
import test from "node:test";

import { createGitLabMcpServer } from "../src/server.mjs";

const SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["api"] }];

function metricEvents(events, metric) {
  return events.filter((event) => event.metric === metric);
}

async function listTools(server) {
  const handler = server.server._requestHandlers.get("tools/list");
  assert.ok(handler);
  return handler({ method: "tools/list", params: {} }, {});
}

test("tool surface metrics measure the final exposed tools/list definitions", async () => {
  const events = [];
  const options = {
    clientFactory: () => ({}),
    deploymentMode: "http",
    readOnly: true,
    securitySchemes: SECURITY_SCHEMES,
  };
  const observedServer = createGitLabMcpServer({
    ...options,
    observabilityObserver: (event) => events.push(event),
  });
  const unobservedServer = createGitLabMcpServer(options);

  const observed = await listTools(observedServer);
  const unobserved = await listTools(unobservedServer);

  assert.deepEqual(observed, unobserved);
  assert.ok(observed.tools.length > 0);
  for (const tool of observed.tools) {
    assert.deepEqual(tool.securitySchemes, SECURITY_SCHEMES);
    assert.deepEqual(tool._meta?.securitySchemes, SECURITY_SCHEMES);
  }

  const [count] = metricEvents(events, "gitlab_mcp.tool.surface.count");
  const [definitionSize] = metricEvents(
    events,
    "gitlab_mcp.tool.surface.definition.size",
  );
  assert.equal(metricEvents(events, "gitlab_mcp.tool.surface.count").length, 1);
  assert.equal(
    metricEvents(events, "gitlab_mcp.tool.surface.definition.size").length,
    1,
  );
  assert.equal(count.value, observed.tools.length);
  assert.equal(
    definitionSize.value,
    Buffer.byteLength(JSON.stringify(observed.tools), "utf8"),
  );
  assert.deepEqual(count.attributes, {
    deployment_mode: "http",
    read_only: "true",
  });
  assert.deepEqual(definitionSize.attributes, count.attributes);
});

test("tool surface metrics collapse unsupported deployment modes to unknown", async () => {
  const events = [];
  const server = createGitLabMcpServer({
    clientFactory: () => ({}),
    deploymentMode: "custom-embedding",
    observabilityObserver: (event) => events.push(event),
  });

  await listTools(server);

  const [count] = metricEvents(events, "gitlab_mcp.tool.surface.count");
  const [definitionSize] = metricEvents(
    events,
    "gitlab_mcp.tool.surface.definition.size",
  );
  assert.ok(count);
  assert.ok(definitionSize);
  assert.deepEqual(count.attributes, {
    deployment_mode: "unknown",
    read_only: "false",
  });
  assert.deepEqual(definitionSize.attributes, count.attributes);
});
