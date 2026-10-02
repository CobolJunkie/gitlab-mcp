import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGitLabMcpServer } from "../src/server.mjs";

async function connectedPair(request) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({ request }),
  });
  const client = new Client({
    name: "merge-request-draft-filter-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function listResponse() {
  return {
    data: [{ iid: 1, title: "Contract MR" }],
    pagination: {},
  };
}

test("maps draft filtering to wip on supported pre-19 GitLab versions", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/version") {
      return { data: { version: "18.11.2" } };
    }
    return listResponse();
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const draft of [true, false]) {
    const result = await client.callTool({
      name: "list_merge_requests",
      arguments: {
        project: "group/project",
        draft,
      },
    });
    assert.equal(result.isError, undefined);
  }

  assert.deepEqual(calls, [
    { path: "/version", options: {} },
    {
      path: "/projects/group%2Fproject/merge_requests",
      options: { query: { wip: "yes" } },
    },
    { path: "/version", options: {} },
    {
      path: "/projects/group%2Fproject/merge_requests",
      options: { query: { wip: "no" } },
    },
  ]);
});

test("uses the native draft filter on GitLab 19 and later", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/version") {
      return { data: { version: "19.0.0-pre" } };
    }
    return listResponse();
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_requests",
    arguments: {
      project: "group/project",
      draft: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/version", options: {} },
    {
      path: "/projects/group%2Fproject/merge_requests",
      options: { query: { draft: true } },
    },
  ]);
});

test("falls back to metadata when the version endpoint is unavailable", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/version") {
      throw new Error("version endpoint unavailable");
    }
    if (path === "/metadata") {
      return { data: { version: "18.11.2" } };
    }
    return listResponse();
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_requests",
    arguments: {
      project: "group/project",
      draft: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { path: "/version", options: {} },
    { path: "/metadata", options: {} },
    {
      path: "/projects/group%2Fproject/merge_requests",
      options: { query: { wip: "yes" } },
    },
  ]);
});

test("keeps unfiltered merge-request listing version-probe free", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    return listResponse();
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_requests",
    arguments: {
      project: "group/project",
      state: "opened",
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests",
      options: { query: { state: "opened" } },
    },
  ]);
});

test("fails closed when GitLab version metadata is ambiguous", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    return { data: { version: "unknown" } };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_requests",
    arguments: {
      project: "group/project",
      draft: true,
    },
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content?.[0]?.text || "",
    /Cannot safely apply merge-request draft filtering/,
  );
  assert.deepEqual(calls, [
    { path: "/version", options: {} },
    { path: "/metadata", options: {} },
  ]);
});

test("fails closed when GitLab version discovery fails", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    throw new Error("upstream unavailable");
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "list_merge_requests",
    arguments: {
      project: "group/project",
      draft: false,
    },
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content?.[0]?.text || "",
    /Cannot safely apply merge-request draft filtering/,
  );
  assert.deepEqual(calls, [
    { path: "/version", options: {} },
    { path: "/metadata", options: {} },
  ]);
});
