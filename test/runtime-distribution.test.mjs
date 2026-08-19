import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createGitLabMcpServer,
  SERVER_VERSION,
} from "../server/src/server.mjs";
import { registerGitLabTools } from "../server/src/tools.mjs";

async function callRuntimeInfo(server) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "distribution-test", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "get_runtime_info",
      arguments: {},
    });
    assert.equal(response.isError, undefined);
    return response.structuredContent.result;
  } finally {
    await client.close();
    await server.close();
  }
}

async function readRuntimeInfo(options = {}) {
  return callRuntimeInfo(
    createGitLabMcpServer({
      ...options,
      clientFactory: () => ({ request: async () => ({ data: {} }) }),
    }),
  );
}

async function readDirectRuntimeInfo(options = {}) {
  const server = new McpServer({ name: "distribution-test", version: "1.0.0" });
  registerGitLabTools(server, {
    ...options,
    clientFactory: () => ({ request: async () => ({ data: {} }) }),
  });
  return callRuntimeInfo(server);
}

const NEUTRAL_CORE_PROVENANCE = {
  name: "gitlab",
  version: SERVER_VERSION,
};

test("bare core defaults to neutral runtime provenance", async () => {
  const runtime = await readRuntimeInfo();
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});

test("undefined embedding metadata preserves neutral core provenance", async () => {
  const runtime = await readRuntimeInfo({ distributionMetadata: undefined });
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});

test("an embedding harness can inject normalized distribution metadata", async () => {
  const runtime = await readRuntimeInfo({
    distributionMetadata: { name: " example-harness ", version: " 2.0.0 " },
  });
  assert.deepEqual(runtime.plugin, {
    name: "example-harness",
    version: "2.0.0",
  });
});

test("embedding harness metadata uses the same validation contract", async () => {
  await assert.rejects(
    () =>
      readRuntimeInfo({
        distributionMetadata: { name: "example-harness", version: "" },
      }),
    /requires non-empty name and version/,
  );
});

test("direct tool registration defaults to neutral core provenance", async () => {
  const runtime = await readDirectRuntimeInfo();
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});

test("undefined direct-registration metadata preserves neutral provenance", async () => {
  const runtime = await readDirectRuntimeInfo({
    distributionMetadata: undefined,
  });
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});

test("direct tool registration uses the shared metadata validation contract", () => {
  const server = new McpServer({ name: "distribution-test", version: "1.0.0" });
  assert.throws(
    () =>
      registerGitLabTools(server, {
        distributionMetadata: { name: "example-harness", version: "" },
      }),
    /requires non-empty name and version/,
  );
});

test("bare core works with an explicit null distribution", async () => {
  const runtime = await readRuntimeInfo({ distributionMetadata: null });
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});

test("direct registration can explicitly select neutral core provenance", async () => {
  const runtime = await readDirectRuntimeInfo({ distributionMetadata: null });
  assert.deepEqual(runtime.plugin, NEUTRAL_CORE_PROVENANCE);
});
