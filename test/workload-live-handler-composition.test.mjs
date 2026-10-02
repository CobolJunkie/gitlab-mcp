import assert from "node:assert/strict";
import test from "node:test";

import { createBaseLiveWorkloadHandlers } from "../scripts/lib/workload-live-base-handlers.mjs";
import { createLiveWorkloadHandlers } from "../scripts/lib/workload-live-handlers.mjs";

const BASE_HANDLER_IDS = [
  "ci.cancel-controlled",
  "ci.play-manual",
  "governance.protected-refs",
  "safety.auth-failure",
  "safety.bounded-response",
  "safety.not-found-recovery",
  "safety.permission-recovery",
  "safety.timeout",
];

function benchmarkSession() {
  const calls = [];
  return {
    project: 15,
    defaultBranch: "main",
    projectPath: "fixture/project",
    projectInfo: { readme_url: "https://example.invalid/README.md" },
    runId: "handler-composition",
    calls,
    measured(_observe, operation) {
      return operation();
    },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        return { name: args.branch, commit: { id: "fixture-head" } };
      }
      if (name === "compare_refs") {
        return { commit: { id: "fixture-head" }, compare_timeout: false };
      }
      if (name === "create_commit") return { id: "fixture-head" };
      if (name === "create_merge_request") {
        return {
          iid: 41,
          state: "opened",
          source_branch: args.source_branch,
          target_branch: args.target_branch,
        };
      }
      if (name === "create_merge_request_discussion") {
        return { id: "owned-discussion" };
      }
      if (name === "resolve_merge_request_discussion") return {};
      if (name === "get_merge_request") {
        return { iid: 41, state: "opened" };
      }
      if (name === "list_merge_request_discussions") {
        return {
          data: [
            {
              id: "owned-discussion",
              notes: [{ resolvable: true, resolved: true }],
            },
          ],
        };
      }
      if (name === "list_branches") {
        return {
          data: [{ name: args.search, commit: { id: "fixture-head" } }],
        };
      }
      if (name === "list_pipelines") return { data: [] };
      if (name === "update_merge_request" || name === "delete_branch")
        return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
}

test("base live handler factory contains only scenarios without hardened overrides", () => {
  assert.deepEqual(
    Object.keys(createBaseLiveWorkloadHandlers(benchmarkSession())).sort(),
    BASE_HANDLER_IDS,
  );
});

test("exported live handler factory exposes the hardened discussion resolver", async () => {
  const session = benchmarkSession();
  const handler = createLiveWorkloadHandlers(session)["mr.resolve-discussion"];

  await handler.setup({ iteration: 1 });
  await handler.execute({ observe: () => {} });
  const verification = await handler.verifyFinalState();
  await handler.cleanup();

  const resolveCall = session.calls.find(
    ({ name }) => name === "resolve_merge_request_discussion",
  );
  assert.equal(resolveCall.args.discussion_id, "owned-discussion");
  assert.equal(verification.verified, true);
});
