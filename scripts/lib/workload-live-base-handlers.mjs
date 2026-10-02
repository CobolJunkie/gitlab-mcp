import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabClient } from "../../server/src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../../server/src/server.mjs";
import {
  cleanupPipelineFixture,
  createPipelineFixture,
  fixtureLabel,
  waitForPipeline,
  waitForPipelineJob,
} from "./workload-live-fixtures.mjs";

function successVerification() {
  return { verified: true, forbiddenEffectsObserved: [] };
}

function measuredRead(session, operation) {
  return {
    execute: ({ observe }) => session.measured(observe, operation),
    verifyFinalState: async () => successVerification(),
  };
}

async function createSyntheticSession({
  fetchImpl,
  timeoutMs = 1_000,
  maxTextBytes = 1_000_000,
} = {}) {
  let activeObserver;
  const observabilityObserver = (event) => activeObserver?.(event);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    deploymentMode: "embedded",
    observabilityObserver,
    clientFactory: (_extra, { observabilityObserver: observer } = {}) =>
      new GitLabClient({
        baseUrl: "https://benchmark.invalid",
        token: "benchmark-fixture-token",
        fetchImpl,
        timeoutMs,
        maxTextBytes,
        observabilityObserver: observer,
      }),
  });
  const client = new Client({
    name: "gitlab-mcp-synthetic-benchmark",
    version: "0.1.0",
  });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    measured: async (observe, operation) => {
      activeObserver = observe;
      try {
        return await operation();
      } finally {
        activeObserver = undefined;
      }
    },
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

function syntheticErrorHandler(status) {
  let synthetic;
  return {
    prepare: async () => {
      synthetic = await createSyntheticSession({
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: `synthetic-${status}` }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      });
    },
    execute: async ({ observe }) =>
      synthetic.measured(observe, async () => {
        const response = await synthetic.call("get_project", {
          project: "synthetic/denied",
        });
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent?.result?.status, status);
      }),
    verifyFinalState: async () => successVerification(),
    finalize: async () => synthetic?.close(),
  };
}

function syntheticTimeoutFetch(_url, { signal }) {
  return new Promise((resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error("synthetic benchmark timeout");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function timeoutHandler() {
  let synthetic;
  return {
    prepare: async () => {
      synthetic = await createSyntheticSession({
        timeoutMs: 25,
        fetchImpl: syntheticTimeoutFetch,
      });
    },
    execute: async ({ observe }) =>
      synthetic.measured(observe, async () => {
        const response = await synthetic.call("get_project", {
          project: "synthetic/timeout",
        });
        assert.equal(response.isError, true);
        assert.match(
          response.structuredContent?.result?.message || "",
          /timed out/i,
        );
      }),
    verifyFinalState: async () => successVerification(),
    finalize: async () => synthetic?.close(),
  };
}

function boundedResponseHandler() {
  let synthetic;
  return {
    prepare: async () => {
      const body = JSON.stringify({ payload: "x".repeat(8_192) });
      synthetic = await createSyntheticSession({
        maxTextBytes: 512,
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            },
          }),
      });
    },
    execute: async ({ observe }) =>
      synthetic.measured(observe, async () => {
        const response = await synthetic.call("get_project", {
          project: "synthetic/oversized",
        });
        assert.equal(response.isError, true);
        assert.match(
          response.structuredContent?.result?.message || "",
          /safety limit|above the/i,
        );
      }),
    verifyFinalState: async () => successVerification(),
    finalize: async () => synthetic?.close(),
  };
}

const MANUAL_CI = `image: node:22-alpine\nstages: [test]\nbenchmark_manual:\n  stage: test\n  script:\n    - echo BENCHMARK_MANUAL_OK\n  when: manual\n`;
const LONG_CI = `image: node:22-alpine\nstages: [test]\nbenchmark_long:\n  stage: test\n  script:\n    - sleep 120\n`;

function playManualHandler(session) {
  let fixture;
  let manualJob;
  return {
    setup: async ({ iteration }) => {
      fixture = await createPipelineFixture(
        session,
        fixtureLabel(session, "ci.play-manual", iteration),
        MANUAL_CI,
      );
      manualJob = await waitForPipelineJob(
        session,
        fixture.pipeline.id,
        (job) => job.status === "manual",
      );
    },
    execute: ({ observe }) =>
      session.measured(observe, () =>
        session.call("play_job", {
          project: session.project,
          job_id: manualJob.id,
        }),
      ),
    verifyFinalState: async () => {
      const job = await waitForPipelineJob(
        session,
        fixture.pipeline.id,
        (entry) => entry.id === manualJob.id && entry.status === "success",
      );
      return {
        verified: job.status === "success",
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupPipelineFixture(session, fixture);
      fixture = undefined;
      manualJob = undefined;
    },
  };
}

function cancelPipelineHandler(session) {
  let fixture;
  return {
    setup: async ({ iteration }) => {
      fixture = await createPipelineFixture(
        session,
        fixtureLabel(session, "ci.cancel-controlled", iteration),
        LONG_CI,
      );
      await waitForPipeline(session, fixture.pipeline.id, [
        "pending",
        "running",
      ]);
    },
    execute: ({ observe }) =>
      session.measured(observe, () =>
        session.call("cancel_pipeline", {
          project: session.project,
          pipeline_id: fixture.pipeline.id,
        }),
      ),
    verifyFinalState: async () => {
      const pipeline = await waitForPipeline(
        session,
        fixture.pipeline.id,
        "canceled",
      );
      return {
        verified: pipeline.status === "canceled",
        forbiddenEffectsObserved: [],
      };
    },
    cleanup: async () => {
      await cleanupPipelineFixture(session, fixture);
      fixture = undefined;
    },
  };
}

export function createBaseLiveWorkloadHandlers(session) {
  const handlers = {};

  handlers["ci.play-manual"] = playManualHandler(session);
  handlers["ci.cancel-controlled"] = cancelPipelineHandler(session);
  handlers["governance.protected-refs"] = measuredRead(session, async () => {
    await session.call("list_protected_branches", {
      project: session.project,
      page: 1,
      per_page: 100,
    });
    await session.call("list_protected_tags", {
      project: session.project,
      page: 1,
      per_page: 100,
    });
  });
  handlers["safety.not-found-recovery"] = measuredRead(session, async () => {
    await session.expectError(
      "get_issue",
      { project: session.project, issue_iid: 2_147_483_647 },
      (result) => result?.status === 404,
    );
    await session.call("get_project", { project: session.project });
  });
  handlers["safety.permission-recovery"] = syntheticErrorHandler(403);
  handlers["safety.auth-failure"] = syntheticErrorHandler(401);
  handlers["safety.timeout"] = timeoutHandler();
  handlers["safety.bounded-response"] = boundedResponseHandler();

  return handlers;
}
