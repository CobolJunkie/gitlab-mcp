import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabClient } from "../../server/src/gitlab-client.mjs";
import { createHttpApp, shutdownHttpServer } from "../../server/src/http.mjs";
import { createGitLabMcpServer } from "../../server/src/server.mjs";

function successVerification() {
  return { verified: true, forbiddenEffectsObserved: [] };
}

export function createReadOnlyMutationBenchmarkHandler({
  fetchImpl = async () =>
    new Response(JSON.stringify({ message: "unexpected GitLab request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
} = {}) {
  let client;
  let server;
  let activeObserver;
  let gitlabRequests = 0;
  let mutationToolAbsent = false;
  let mutationRejected = false;

  return {
    prepare: async () => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      server = createGitLabMcpServer({
        readOnly: true,
        deploymentMode: "embedded",
        observabilityObserver: (event) => activeObserver?.(event),
        clientFactory: (_extra, { observabilityObserver: observer } = {}) =>
          new GitLabClient({
            baseUrl: "https://benchmark.invalid",
            token: "benchmark-fixture-token",
            fetchImpl: async (...args) => {
              gitlabRequests += 1;
              return fetchImpl(...args);
            },
            observabilityObserver: observer,
          }),
      });
      client = new Client({
        name: "gitlab-mcp-read-only-benchmark",
        version: "0.1.0",
      });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    },
    setup: async () => {
      gitlabRequests = 0;
      mutationToolAbsent = false;
      mutationRejected = false;
    },
    execute: async ({ observe }) => {
      activeObserver = observe;
      try {
        const inventory = await client.listTools();
        mutationToolAbsent = !inventory.tools.some(
          (tool) => tool.name === "create_issue",
        );
        assert.equal(
          mutationToolAbsent,
          true,
          "Read-only benchmark unexpectedly exposed create_issue.",
        );

        try {
          const response = await client.callTool({
            name: "create_issue",
            arguments: {
              project: "synthetic/read-only",
              title: "must not be created",
            },
          });
          mutationRejected = response.isError === true;
        } catch {
          mutationRejected = true;
        }

        assert.equal(
          mutationRejected,
          true,
          "Read-only benchmark mutation attempt was not rejected.",
        );
        assert.equal(
          gitlabRequests,
          0,
          "Read-only benchmark mutation attempt reached the GitLab client.",
        );
      } finally {
        activeObserver = undefined;
      }
    },
    verifyFinalState: async () => ({
      verified: mutationToolAbsent && mutationRejected && gitlabRequests === 0,
      forbiddenEffectsObserved:
        gitlabRequests === 0 ? [] : ["gitlab_request_reached"],
    }),
    cleanup: async () => {
      activeObserver = undefined;
    },
    finalize: async () => {
      await client?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
    },
  };
}

async function cancelFetchResponse(responsePromise) {
  try {
    const response = await responsePromise;
    await response?.body?.cancel();
  } catch {
    // Preserve the benchmark request/assertion outcome while releasing resources.
  }
}

export function createAdmissionLimitBenchmarkHandler() {
  let state;
  let activeObserver;
  let started;
  let release;
  let requestSequence = 0;

  return {
    prepare: async () => {
      requestSequence = 0;
      const { app } = createHttpApp({
        host: "127.0.0.1",
        publicUrl: "https://mcp.example.com/mcp",
        gitlabUrl: "https://gitlab.example.com",
        maxConcurrentRequests: 1,
        observabilityObserver: (event) => activeObserver?.(event),
        tokenValidator: async () => {
          started?.();
          await new Promise((resolve) => {
            release = resolve;
          });
          return { id: 7, username: "benchmark" };
        },
      });
      const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", (error) => {
          if (error) reject(error);
          else resolve(listening);
        });
      });
      const address = server.address();
      state = {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    setup: async () => {
      release = undefined;
    },
    execute: async ({ observe }) => {
      activeObserver = observe;
      const sequence = requestSequence;
      requestSequence += 1;
      const validationStarted = new Promise((resolve) => {
        started = resolve;
      });
      const request = (token) =>
        fetch(`${state.baseUrl}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        });
      let first;
      let limited;
      try {
        first = request(`benchmark-first-${sequence}`);
        await validationStarted;
        limited = request(`benchmark-second-${sequence}`);
        const limitedResponse = await limited;
        assert.equal(limitedResponse.status, 429);
        assert.equal(limitedResponse.headers.get("retry-after"), "1");
        release?.();
        const firstResponse = await first;
        assert.equal(firstResponse.status, 200);
      } finally {
        release?.();
        await Promise.all([
          cancelFetchResponse(first),
          cancelFetchResponse(limited),
        ]);
        started = undefined;
        activeObserver = undefined;
      }
    },
    verifyFinalState: async () => successVerification(),
    cleanup: async () => {
      release?.();
      started = undefined;
    },
    finalize: async () => {
      release?.();
      if (state?.server) {
        await shutdownHttpServer(state.server, { timeoutMs: 1_000 });
      }
    },
  };
}
