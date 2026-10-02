import assert from "node:assert/strict";
import test from "node:test";

import { applyVerifiedReadWorkloadOverrides } from "../scripts/lib/workload-live-read-overrides.mjs";

test("compare-refs read override verifies the exact fixture commit and cleans its branch", async () => {
  const calls = [];
  let fixtureBranch;
  const session = {
    project: 42,
    defaultBranch: "main",
    runId: "bench-read",
    measured(_observe, operation) {
      return operation();
    },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        fixtureBranch = args.branch;
        return { name: args.branch };
      }
      if (name === "create_commit") return { id: "compare-sha" };
      if (name === "compare_refs") {
        return {
          commits: [{ id: "compare-sha" }],
          diffs: [{ new_path: "fixture.txt" }],
        };
      }
      if (name === "list_branches") {
        return {
          data: [
            {
              name: fixtureBranch,
              commit: { id: "compare-sha" },
            },
          ],
        };
      }
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_branch") return { deleted: true };
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handlers = applyVerifiedReadWorkloadOverrides(session, {
    "repository.compare-refs": { marker: "old" },
  });
  const handler = handlers["repository.compare-refs"];

  await handler.prepare();
  await handler.execute({ observe: () => {} });
  assert.deepEqual(await handler.verifyFinalState(), {
    verified: true,
    forbiddenEffectsObserved: [],
  });
  await handler.finalize();

  const comparison = calls.find((entry) => entry.name === "compare_refs");
  assert.equal(comparison.args.from, "main");
  assert.equal(comparison.args.to, fixtureBranch);
  assert.equal(
    calls.some((entry) => entry.name === "delete_branch"),
    true,
  );
});
