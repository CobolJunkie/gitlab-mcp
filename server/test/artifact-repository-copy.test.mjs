import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

async function connectedPair(clientFactory) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({ clientFactory });
  const client = new Client({ name: "artifact-copy-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

const expectedHead = "a".repeat(40);
const resultingCommit = "c".repeat(40);
const artifactBytes = Buffer.from("generated benchmark\n");

function argumentsFor(mode = "update") {
  return {
    source_project: "group/source",
    job_id: 42,
    artifact_path: "reports/result.json",
    target_project: "group/target",
    target_branch: "main",
    target_path: "benchmarks/result.json",
    expected_head_sha: expectedHead,
    mode,
    commit_message: "benchmarks: promote result",
  };
}

test("commits a bounded job artifact without returning its contents", async (t) => {
  const calls = [];
  let committed = false;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      const route = String(path);
      calls.push({ route, options });
      if (route.endsWith("/repository/branches/main")) {
        return {
          data: { commit: { id: committed ? resultingCommit : expectedHead } },
        };
      }
      if (route.endsWith("/jobs/42/artifacts/reports%2Fresult.json")) {
        return {
          data: {
            encoding: "base64",
            contentType: "application/json",
            contentLength: artifactBytes.length,
            content: artifactBytes.toString("base64"),
          },
        };
      }
      if (route.endsWith("/repository/files/benchmarks%2Fresult.json")) {
        return {
          data: {
            last_commit_id: "last-target-commit",
            blob_id: "b".repeat(40),
          },
        };
      }
      if (route.endsWith("/repository/commits") && options.method === "POST") {
        committed = true;
        return { data: { id: resultingCommit, short_id: "cccccccc" } };
      }
      if (route.endsWith(`/repository/commits/${resultingCommit}`)) {
        return {
          data: { id: resultingCommit, parent_ids: [expectedHead] },
        };
      }
      throw new Error(`Unexpected request: ${route}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "commit_job_artifact_file",
    arguments: argumentsFor("update"),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result.id, resultingCommit);
  assert.deepEqual(result.structuredContent.result.changed_paths, [
    "benchmarks/result.json",
  ]);
  assert.equal(result.structuredContent.result.source.content_length, 20);
  assert.doesNotMatch(JSON.stringify(result), /generated benchmark/);

  const commitCall = calls.find(
    ({ route, options }) =>
      route.endsWith("/repository/commits") && options.method === "POST",
  );
  assert.deepEqual(commitCall.options.body.actions, [
    {
      action: "update",
      file_path: "benchmarks/result.json",
      content: artifactBytes.toString("base64"),
      encoding: "base64",
      last_commit_id: "last-target-commit",
    },
  ]);
});

test("rejects stale target heads before reading the artifact", async (t) => {
  const calls = [];
  const { client, server } = await connectedPair(() => ({
    request: async (path) => {
      calls.push(String(path));
      return { data: { commit: { id: "b".repeat(40) } } };
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "commit_job_artifact_file",
    arguments: argumentsFor("create"),
  });

  assert.equal(result.isError, true);
  assert.match(result.structuredContent.result.message, /expected_head_sha/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /artifacts/);
});

test("fails closed when the artifact is missing or exceeds the byte limit", async (t) => {
  for (const artifactError of [
    new GitLabApiError("Artifact not found", {
      status: 404,
      method: "GET",
      path: "/projects/group%2Fsource/jobs/42/artifacts/reports%2Fresult.json",
    }),
    new Error("binary response exceeded the configured 1000-byte limit"),
  ]) {
    let commitCalls = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        const route = String(path);
        if (route.endsWith("/repository/branches/main")) {
          return { data: { commit: { id: expectedHead } } };
        }
        if (route.endsWith("/jobs/42/artifacts/reports%2Fresult.json")) {
          assert.equal(options.responseType, "binary");
          assert.equal(options.maxBytes, 1_000);
          throw artifactError;
        }
        if (
          route.endsWith("/repository/commits") &&
          options.method === "POST"
        ) {
          commitCalls += 1;
        }
        throw new Error(`Unexpected request: ${route}`);
      },
    }));
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "commit_job_artifact_file",
      arguments: { ...argumentsFor("create"), max_bytes: 1_000 },
    });
    assert.equal(result.isError, true);
    assert.equal(commitCalls, 0);
  }
});

test("rejects create collisions and update misses without committing", async (t) => {
  for (const mode of ["create", "update"]) {
    let commitCalls = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        const route = String(path);
        if (route.endsWith("/repository/branches/main")) {
          return { data: { commit: { id: expectedHead } } };
        }
        if (route.endsWith("/jobs/42/artifacts/reports%2Fresult.json")) {
          return {
            data: {
              encoding: "base64",
              contentType: "application/json",
              contentLength: artifactBytes.length,
              content: artifactBytes.toString("base64"),
            },
          };
        }
        if (route.endsWith("/repository/files/benchmarks%2Fresult.json")) {
          if (mode === "create") {
            return { data: { last_commit_id: "existing" } };
          }
          throw new GitLabApiError("Not found", {
            status: 404,
            method: "GET",
            path: route,
          });
        }
        if (
          route.endsWith("/repository/commits") &&
          options.method === "POST"
        ) {
          commitCalls += 1;
        }
        throw new Error(`Unexpected request: ${route}`);
      },
    }));
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "commit_job_artifact_file",
      arguments: argumentsFor(mode),
    });
    assert.equal(result.isError, true, mode);
    assert.equal(commitCalls, 0, mode);
  }
});

test("rejects target-branch drift immediately before the commit", async (t) => {
  let branchReads = 0;
  let commitCalls = 0;
  const { client, server } = await connectedPair(() => ({
    request: async (path, options = {}) => {
      const route = String(path);
      if (route.endsWith("/repository/branches/main")) {
        branchReads += 1;
        return {
          data: {
            commit: { id: branchReads === 1 ? expectedHead : "b".repeat(40) },
          },
        };
      }
      if (route.endsWith("/jobs/42/artifacts/reports%2Fresult.json")) {
        return {
          data: {
            encoding: "base64",
            contentType: "application/json",
            contentLength: artifactBytes.length,
            content: artifactBytes.toString("base64"),
          },
        };
      }
      if (route.endsWith("/repository/files/benchmarks%2Fresult.json")) {
        return { data: { last_commit_id: "last-target-commit" } };
      }
      if (route.endsWith("/repository/commits") && options.method === "POST") {
        commitCalls += 1;
      }
      throw new Error(`Unexpected request: ${route}`);
    },
  }));
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "commit_job_artifact_file",
    arguments: argumentsFor("update"),
  });

  assert.equal(result.isError, true);
  assert.match(result.structuredContent.result.message, /expected_head_sha/);
  assert.equal(commitCalls, 0);
});

test("surfaces ambiguous postflight state after GitLab accepts the commit", async (t) => {
  for (const failure of ["parent", "branch"]) {
    let committed = false;
    let branchReads = 0;
    const { client, server } = await connectedPair(() => ({
      request: async (path, options = {}) => {
        const route = String(path);
        if (route.endsWith("/repository/branches/main")) {
          branchReads += 1;
          if (!committed || branchReads <= 2) {
            return { data: { commit: { id: expectedHead } } };
          }
          return {
            data: {
              commit: {
                id: failure === "branch" ? "d".repeat(40) : resultingCommit,
              },
            },
          };
        }
        if (route.endsWith("/jobs/42/artifacts/reports%2Fresult.json")) {
          return {
            data: {
              encoding: "base64",
              contentType: "application/json",
              contentLength: artifactBytes.length,
              content: artifactBytes.toString("base64"),
            },
          };
        }
        if (route.endsWith("/repository/files/benchmarks%2Fresult.json")) {
          return { data: { last_commit_id: "last-target-commit" } };
        }
        if (
          route.endsWith("/repository/commits") &&
          options.method === "POST"
        ) {
          committed = true;
          return { data: { id: resultingCommit } };
        }
        if (route.endsWith(`/repository/commits/${resultingCommit}`)) {
          return {
            data: {
              id: resultingCommit,
              parent_ids:
                failure === "parent" ? ["b".repeat(40)] : [expectedHead],
            },
          };
        }
        throw new Error(`Unexpected request: ${route}`);
      },
    }));
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "commit_job_artifact_file",
      arguments: argumentsFor("update"),
    });

    assert.equal(result.isError, true, failure);
    assert.equal(committed, true, failure);
    assert.match(
      result.structuredContent.result.message,
      failure === "parent"
        ? /does not directly descend/
        : /no longer points at the resulting commit/,
    );
  }
});

test("rejects unsafe source and target paths before any GitLab request", async (t) => {
  for (const overrides of [
    { artifact_path: "../secret.txt" },
    { target_path: "/absolute.txt" },
    { target_path: "dir//file.txt" },
  ]) {
    let calls = 0;
    const { client, server } = await connectedPair(() => ({
      request: async () => {
        calls += 1;
        return { data: {} };
      },
    }));
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "commit_job_artifact_file",
      arguments: { ...argumentsFor("create"), ...overrides },
    });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  }
});
