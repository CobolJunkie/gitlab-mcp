import assert from "node:assert/strict";
import test from "node:test";

import { applyLiveWorkloadOverrides } from "../scripts/lib/workload-live-overrides.mjs";

function baseSession() {
  return {
    project: 42,
    defaultBranch: "main",
    runId: "bench-run",
    projectInfo: { readme_url: "https://example.invalid/readme" },
    measured(_observe, operation) {
      return operation();
    },
  };
}

test("retry override rejects a response for a different pipeline", async () => {
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_branch") return { name: args.branch };
      if (name === "create_commit") return { id: "retry-sha" };
      if (name === "list_pipelines") {
        return { id: 61, sha: "retry-sha", status: "failed" };
      }
      if (name === "get_pipeline") return { id: 61, status: "failed" };
      if (name === "retry_pipeline") return { id: 62, status: "pending" };
      if (name === "list_branches") {
        return { data: [{ name: args.search, commit: { id: "retry-sha" } }] };
      }
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name} ${JSON.stringify(args)}`);
    },
  };
  const handlers = applyLiveWorkloadOverrides(session, {
    "ci.retry-failed": { marker: "old-retry" },
  });
  const handler = handlers["ci.retry-failed"];

  await handler.setup({ iteration: 1 });
  await handler.execute({ observe: () => {} });
  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, false);
  await handler.cleanup();
});

test("release asset override requires the exact created asset link", async () => {
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_tag") return { name: args.tag_name };
      if (name === "create_release") return { tag_name: args.tag_name };
      if (name === "create_release_asset_link") return { id: 77 };
      if (name === "list_release_asset_links") return { data: [{ id: 76 }] };
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_release" || name === "delete_tag") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handlers = applyLiveWorkloadOverrides(session, {
    "release.asset-flow": { marker: "old-asset" },
  });
  const handler = handlers["release.asset-flow"];

  await handler.execute({ observe: () => {}, iteration: 2 });
  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, false);
  await handler.cleanup();
});
