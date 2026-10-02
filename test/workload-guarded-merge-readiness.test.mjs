import assert from "node:assert/strict";
import test from "node:test";

import { applyLiveWorkloadOverrides } from "../scripts/lib/workload-live-overrides.mjs";

test("guarded merge refuses readiness drift before the destructive call", async () => {
  const calls = [];
  let mergeRequestArgs;
  let mergeRequestReads = 0;
  const session = {
    project: 42,
    defaultBranch: "main",
    runId: "bench-run",
    projectInfo: { readme_url: "https://example.invalid/readme" },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        return { name: args.branch, commit: { id: "fixture-commit" } };
      }
      if (name === "compare_refs") {
        return { commit: { id: "fixture-commit" }, compare_timeout: false };
      }
      if (name === "create_commit") return { id: "fixture-commit" };
      if (name === "create_merge_request") {
        mergeRequestArgs = args;
        return { iid: 18, state: "opened", draft: false };
      }
      if (name === "get_merge_request") {
        mergeRequestReads += 1;
        return {
          iid: 18,
          state: "opened",
          draft: mergeRequestReads > 1,
          work_in_progress: false,
          merge_status: "can_be_merged",
          detailed_merge_status: "mergeable",
          source_branch: mergeRequestArgs.source_branch,
          target_branch: mergeRequestArgs.target_branch,
          sha: "fixture-commit",
        };
      }
      if (name === "merge_merge_request") {
        assert.fail("Destructive merge must not run after readiness drift.");
      }
      if (name === "update_merge_request") return { state: "closed" };
      if (name === "list_branches") {
        return {
          data: [{ name: args.search, commit: { id: "fixture-commit" } }],
        };
      }
      return undefined;
    },
    measured(_observe, operation) {
      return operation();
    },
  };

  const handlers = applyLiveWorkloadOverrides(session, {
    "mr.guarded-merge": { marker: "old-merge" },
  });
  const handler = handlers["mr.guarded-merge"];

  await handler.setup({ iteration: 3 });
  await assert.rejects(
    handler.execute({ observe: () => {} }),
    /merge-ready state/,
  );
  assert.equal(
    calls.filter((entry) => entry.name === "merge_merge_request").length,
    0,
  );
  await handler.cleanup();
});
