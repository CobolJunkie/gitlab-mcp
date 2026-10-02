import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

const CURRENT_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);

async function connectedPair(request) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({ request }),
  });
  const client = new Client({
    name: "merge-request-head-guard-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test("merge and approval schemas require a full reviewed MR head SHA", async (t) => {
  const { client, server } = await connectedPair(async () => ({ data: {} }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

  for (const name of ["merge_merge_request", "approve_merge_request"]) {
    const tool = byName.get(name);
    assert.ok(tool);
    assert.equal(tool.inputSchema.required.includes("sha"), true);
    assert.equal(tool.inputSchema.properties.sha.type, "string");
    assert.match(
      tool.inputSchema.properties.sha.description,
      /40-character SHA/,
    );
  }
});

test("missing or malformed reviewed SHA fails before any GitLab mutation", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options) => {
    calls.push({ path, options });
    return { data: {} };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const name of ["merge_merge_request", "approve_merge_request"]) {
    for (const invalidSha of [undefined, "abcdef123456", "g".repeat(40)]) {
      const args = {
        project: "group/project",
        merge_request_iid: 1,
      };
      if (invalidSha !== undefined) {
        args.sha = invalidSha;
      }
      const result = await client.callTool({
        name,
        arguments: args,
      });
      assert.equal(result.isError, true);
    }
  }

  assert.equal(calls.length, 0, "invalid input must not reach GitLab");
});

test("current reviewed SHA is forwarded for merge, auto-merge, and approval", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    assert.equal(options.body?.sha, CURRENT_SHA);
    return { data: { state: "accepted" } };
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const merge = await client.callTool({
    name: "merge_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      sha: CURRENT_SHA,
      auto_merge: true,
      merge_when_pipeline_succeeds: true,
      squash: true,
    },
  });
  assert.equal(merge.isError, undefined);

  const approval = await client.callTool({
    name: "approve_merge_request",
    arguments: {
      project: "group/project",
      merge_request_iid: 1,
      sha: CURRENT_SHA,
    },
  });
  assert.equal(approval.isError, undefined);

  assert.deepEqual(calls, [
    {
      path: "/projects/group%2Fproject/merge_requests/1/merge",
      options: {
        method: "PUT",
        body: {
          sha: CURRENT_SHA,
          squash: true,
          merge_when_pipeline_succeeds: true,
          auto_merge: true,
        },
      },
    },
    {
      path: "/projects/group%2Fproject/merge_requests/1/approve",
      options: {
        method: "POST",
        body: { sha: CURRENT_SHA },
      },
    },
  ]);
});

test("native stale-SHA rejection is preserved for merge and approval", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    throw new GitLabApiError("GitLab API returned 409 Conflict.", {
      status: 409,
      method: options.method,
      path: String(path),
    });
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const name of ["merge_merge_request", "approve_merge_request"]) {
    const result = await client.callTool({
      name,
      arguments: {
        project: "group/project",
        merge_request_iid: 1,
        sha: STALE_SHA,
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.result.status, 409);
    assert.match(result.structuredContent.result.message, /409 Conflict/);
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.sha, STALE_SHA);
  assert.equal(calls[1].options.body.sha, STALE_SHA);
});
