import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

async function connectedPair(request) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({ request }),
  });
  const client = new Client({ name: "cherry-pick-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function args(overrides = {}) {
  return {
    project: "group/project",
    branch: "release/1.x",
    sha: "b".repeat(40),
    expected_head_sha: "a".repeat(40),
    ...overrides,
  };
}

test("cherry_pick_commit dry-runs, rechecks, cherry-picks once, verifies, and bounds changes", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const resultSha = "c".repeat(40);
  const calls = [];
  let mutationCompleted = false;

  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    if (
      path === "/projects/group%2Fproject/repository/branches/release%2F1.x"
    ) {
      return {
        data: { commit: { id: mutationCompleted ? resultSha : expectedHead } },
      };
    }
    if (path === `/projects/group%2Fproject/repository/commits/${sourceSha}`) {
      return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
    }
    if (
      path ===
        `/projects/group%2Fproject/repository/commits/${sourceSha}/cherry_pick` &&
      options.method === "POST"
    ) {
      if (options.body?.dry_run === true) {
        return { data: { dry_run: "success" } };
      }
      mutationCompleted = true;
      return { data: { id: resultSha } };
    }
    if (path === `/projects/group%2Fproject/repository/commits/${resultSha}`) {
      return {
        data: {
          id: resultSha,
          short_id: resultSha.slice(0, 8),
          title: "Backport reviewed fix",
          message: "Backport reviewed fix\n",
          parent_ids: [expectedHead],
          author_name: "Original Author",
          author_email: "hidden@example.com",
          committer_name: "Cherry Picker",
          committer_email: "hidden@example.com",
          web_url: "https://gitlab.example.com/group/project/-/commit/result",
        },
      };
    }
    if (
      path === `/projects/group%2Fproject/repository/commits/${resultSha}/diff`
    ) {
      return {
        data: [
          {
            old_path: "src/a.js",
            new_path: "src/a.js",
            diff: "x".repeat(5_000),
          },
        ],
        pagination: {},
      };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args({ message: "Backport reviewed fix" }),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.id, resultSha);
  assert.deepEqual(result.structuredContent.result.parent_ids, [expectedHead]);
  assert.equal(result.structuredContent.result.author_email, undefined);
  assert.equal(result.structuredContent.result.committer_email, undefined);
  assert.deepEqual(result.structuredContent.result.changed_paths, ["src/a.js"]);
  assert.equal(result.structuredContent.result.changes.length, 1);
  assert.equal(
    result.structuredContent.result.changes[0].diff_excerpt.length,
    4_000,
  );

  const cherryPickCalls = calls.filter((call) =>
    String(call.path).endsWith(`/${sourceSha}/cherry_pick`),
  );
  assert.equal(cherryPickCalls.length, 2);
  assert.deepEqual(cherryPickCalls[0].options.body, {
    branch: "release/1.x",
    dry_run: true,
    message: "Backport reviewed fix",
  });
  assert.deepEqual(cherryPickCalls[1].options.body, {
    branch: "release/1.x",
    message: "Backport reviewed fix",
  });
});

test("cherry_pick_commit dry_run validates without mutating", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  let mutations = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: expectedHead } } };
    }
    if (path.endsWith(`/repository/commits/${sourceSha}`)) {
      return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
    }
    if (path.endsWith("/cherry_pick") && options.method === "POST") {
      if (options.body?.dry_run === true) {
        return { data: { dry_run: "success" } };
      }
      mutations += 1;
      return { data: { id: "c".repeat(40) } };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args({ dry_run: true }),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.dry_run, true);
  assert.equal(
    result.structuredContent.result.native_cherry_pick_check,
    "success",
  );
  assert.equal(mutations, 0);
});

test("cherry_pick_commit rejects stale expected target head before any POST", async (t) => {
  let postCalls = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: "d".repeat(40) } } };
    }
    if (options.method === "POST") postCalls += 1;
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha/);
  assert.equal(postCalls, 0);
});

for (const errorCode of ["conflict", "empty"]) {
  test(`cherry_pick_commit fails closed when GitLab dry-run reports ${errorCode}`, async (t) => {
    const expectedHead = "a".repeat(40);
    const sourceSha = "b".repeat(40);
    let mutations = 0;
    const { client, server } = await connectedPair(
      async (path, options = {}) => {
        if (path.includes("/repository/branches/")) {
          return { data: { commit: { id: expectedHead } } };
        }
        if (path.endsWith(`/repository/commits/${sourceSha}`)) {
          return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
        }
        if (
          path.endsWith("/cherry_pick") &&
          options.method === "POST" &&
          options.body?.dry_run === true
        ) {
          throw new GitLabApiError("GitLab cherry-pick dry-run failed.", {
            status: 400,
            method: "POST",
            path,
            response: { error_code: errorCode },
          });
        }
        if (path.endsWith("/cherry_pick") && options.method === "POST") {
          mutations += 1;
          return { data: { id: "c".repeat(40) } };
        }
        throw new Error(
          `Unexpected request ${options.method || "GET"} ${path}`,
        );
      },
    );
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "cherry_pick_commit",
      arguments: args(),
    });

    assert.equal(result.isError, true);
    assert.equal(mutations, 0);
  });
}

test("cherry_pick_commit rejects merge commits because no explicit mainline selector exists", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  let postCalls = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: expectedHead } } };
    }
    if (path.endsWith(`/repository/commits/${sourceSha}`)) {
      return {
        data: {
          id: sourceSha,
          parent_ids: ["d".repeat(40), "e".repeat(40)],
        },
      };
    }
    if (options.method === "POST") postCalls += 1;
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mainline parent/);
  assert.equal(postCalls, 0);
});

test("cherry_pick_commit rejects target drift after dry-run without mutating", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  let branchReads = 0;
  let mutations = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      branchReads += 1;
      return {
        data: {
          commit: {
            id: branchReads === 1 ? expectedHead : "d".repeat(40),
          },
        },
      };
    }
    if (path.endsWith(`/repository/commits/${sourceSha}`)) {
      return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
    }
    if (
      path.endsWith("/cherry_pick") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/cherry_pick") && options.method === "POST") {
      mutations += 1;
      return { data: { id: "unexpected" } };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha/);
  assert.equal(mutations, 0);
});

test("cherry_pick_commit reports a concurrent-parent mismatch after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const resultSha = "c".repeat(40);
  let mutations = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: expectedHead } } };
    }
    if (path.endsWith(`/repository/commits/${sourceSha}`)) {
      return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
    }
    if (
      path.endsWith("/cherry_pick") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/cherry_pick") && options.method === "POST") {
      mutations += 1;
      return { data: { id: resultSha } };
    }
    if (path.endsWith(`/repository/commits/${resultSha}`)) {
      return {
        data: { id: resultSha, parent_ids: ["d".repeat(40)] },
      };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not directly descend/);
  assert.equal(mutations, 1);
});

test("cherry_pick_commit reports a branch-pointer race after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const resultSha = "c".repeat(40);
  let branchReads = 0;
  let mutations = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      branchReads += 1;
      return {
        data: {
          commit: {
            id: branchReads <= 2 ? expectedHead : "d".repeat(40),
          },
        },
      };
    }
    if (path.endsWith(`/repository/commits/${sourceSha}`)) {
      return { data: { id: sourceSha, parent_ids: ["d".repeat(40)] } };
    }
    if (
      path.endsWith("/cherry_pick") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/cherry_pick") && options.method === "POST") {
      mutations += 1;
      return { data: { id: resultSha } };
    }
    if (path.endsWith(`/repository/commits/${resultSha}`)) {
      return {
        data: { id: resultSha, parent_ids: [expectedHead] },
      };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "cherry_pick_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no longer points/);
  assert.equal(mutations, 1);
});
