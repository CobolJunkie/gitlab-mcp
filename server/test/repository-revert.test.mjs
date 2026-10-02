import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

async function connectedPair(request, { mergeBaseSha = "b".repeat(40) } = {}) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      request: async (path, options = {}) => {
        if (path === "/projects/group%2Fproject/repository/merge_base") {
          return { data: { id: mergeBaseSha } };
        }
        return request(path, options);
      },
    }),
  });
  const client = new Client({ name: "revert-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function args(overrides = {}) {
  return {
    project: "group/project",
    branch: "codex/revert",
    sha: "b".repeat(40),
    expected_head_sha: "a".repeat(40),
    ...overrides,
  };
}

test("revert_commit dry-runs, rechecks, reverts once, and verifies the result", async (t) => {
  const expectedHead = "a".repeat(40);
  const revertSha = "b".repeat(40);
  const resultSha = "c".repeat(40);
  const calls = [];
  let mutationCompleted = false;

  const { client, server } = await connectedPair(async (path, options = {}) => {
    calls.push({ path, options });
    if (
      path === "/projects/group%2Fproject/repository/branches/codex%2Frevert"
    ) {
      return {
        data: {
          commit: { id: mutationCompleted ? resultSha : expectedHead },
        },
      };
    }
    if (
      path ===
        `/projects/group%2Fproject/repository/commits/${revertSha}/revert` &&
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
          title: 'Revert "reviewed change"',
          message: 'Revert "reviewed change"\n',
          parent_ids: [expectedHead],
          author_name: "Contract Author",
          author_email: "hidden@example.com",
          authored_date: "2026-09-26T00:00:00Z",
          committer_name: "Contract Committer",
          committer_email: "hidden@example.com",
          committed_date: "2026-09-26T00:00:00Z",
          created_at: "2026-09-26T00:00:00Z",
          web_url: "https://gitlab.example.com/group/project/-/commit/result",
        },
      };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.id, resultSha);
  assert.deepEqual(result.structuredContent.result.parent_ids, [expectedHead]);
  assert.equal(result.structuredContent.result.author_email, undefined);
  assert.equal(result.structuredContent.result.committer_email, undefined);

  const revertCalls = calls.filter((call) =>
    String(call.path).endsWith(`/${revertSha}/revert`),
  );
  assert.equal(revertCalls.length, 2);
  assert.deepEqual(revertCalls[0].options, {
    method: "POST",
    body: { branch: "codex/revert", dry_run: true },
  });
  assert.deepEqual(revertCalls[1].options, {
    method: "POST",
    body: { branch: "codex/revert" },
  });
  assert.equal(
    calls.filter(
      (call) =>
        call.path ===
        "/projects/group%2Fproject/repository/branches/codex%2Frevert",
    ).length,
    3,
  );
});

test("revert_commit dry_run validates without creating a revert commit", async (t) => {
  const expectedHead = "a".repeat(40);
  let actualReverts = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: expectedHead } } };
    }
    if (path.endsWith("/revert") && options.method === "POST") {
      if (options.body?.dry_run === true) {
        return { data: { dry_run: "success" } };
      }
      actualReverts += 1;
      return { data: { id: "unexpected" } };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "revert_commit",
    arguments: args({ dry_run: true }),
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.result, {
    dry_run: true,
    branch: "codex/revert",
    commit_sha: "b".repeat(40),
    expected_head_sha: expectedHead,
    native_revert_check: "success",
  });
  assert.equal(actualReverts, 0);
});

test("revert_commit rejects a stale expected branch head before any POST", async (t) => {
  let postCalls = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: "d".repeat(40) } } };
    }
    if (options.method === "POST") {
      postCalls += 1;
      return { data: {} };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha/);
  assert.equal(postCalls, 0);
});

test("revert_commit rejects a commit outside the reviewed target history before any POST", async (t) => {
  const expectedHead = "a".repeat(40);
  let postCalls = 0;
  const { client, server } = await connectedPair(
    async (path, options = {}) => {
      if (path.includes("/repository/branches/")) {
        return { data: { commit: { id: expectedHead } } };
      }
      if (options.method === "POST") {
        postCalls += 1;
        return { data: {} };
      }
      throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
    },
    { mergeBaseSha: "f".repeat(40) },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /not in the reviewed target-branch history/,
  );
  assert.equal(postCalls, 0);
});

for (const errorCode of ["conflict", "empty"]) {
  test(`revert_commit fails closed when GitLab dry-run reports ${errorCode}`, async (t) => {
    const expectedHead = "a".repeat(40);
    let actualReverts = 0;
    const { client, server } = await connectedPair(
      async (path, options = {}) => {
        if (path.includes("/repository/branches/")) {
          return { data: { commit: { id: expectedHead } } };
        }
        if (
          path.endsWith("/revert") &&
          options.method === "POST" &&
          options.body?.dry_run === true
        ) {
          throw new GitLabApiError("GitLab revert dry-run failed.", {
            status: 400,
            method: "POST",
            path,
            response: { error_code: errorCode },
          });
        }
        if (path.endsWith("/revert") && options.method === "POST") {
          actualReverts += 1;
          return { data: { id: "unexpected" } };
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
      name: "revert_commit",
      arguments: args(),
    });

    assert.equal(result.isError, true);
    assert.equal(actualReverts, 0);
  });
}

test("revert_commit rejects target drift after dry-run without mutating", async (t) => {
  const expectedHead = "a".repeat(40);
  let branchReads = 0;
  let actualReverts = 0;
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
    if (
      path.endsWith("/revert") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/revert") && options.method === "POST") {
      actualReverts += 1;
      return { data: { id: "unexpected" } };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected_head_sha/);
  assert.equal(actualReverts, 0);
});

test("revert_commit reports a concurrent-parent mismatch after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  const resultSha = "c".repeat(40);
  let actualReverts = 0;
  const { client, server } = await connectedPair(async (path, options = {}) => {
    if (path.includes("/repository/branches/")) {
      return { data: { commit: { id: expectedHead } } };
    }
    if (
      path.endsWith("/revert") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/revert") && options.method === "POST") {
      actualReverts += 1;
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
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not directly descend/);
  assert.equal(actualReverts, 1);
});

test("revert_commit reports a branch-pointer race after mutation", async (t) => {
  const expectedHead = "a".repeat(40);
  const resultSha = "c".repeat(40);
  let branchReads = 0;
  let actualReverts = 0;
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
    if (
      path.endsWith("/revert") &&
      options.method === "POST" &&
      options.body?.dry_run === true
    ) {
      return { data: { dry_run: "success" } };
    }
    if (path.endsWith("/revert") && options.method === "POST") {
      actualReverts += 1;
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
    name: "revert_commit",
    arguments: args(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no longer points/);
  assert.equal(actualReverts, 1);
});
