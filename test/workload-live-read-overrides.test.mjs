import assert from "node:assert/strict";
import test from "node:test";

import { applyVerifiedReadWorkloadOverrides } from "../scripts/lib/workload-live-read-overrides.mjs";

const VERIFIED_READ_IDS = [
  "repository.compare-refs",
  "issues.inspect-thread",
  "mr.review-metadata-diff",
  "mr.review-discussions",
  "mr.merge-readiness",
  "ci.diagnose-failure",
  "ci.bounded-log",
  "governance.approvals",
  "release.inspect",
  "deployment.inspect",
];

function baseSession() {
  return {
    project: 42,
    defaultBranch: "main",
    runId: "bench-read",
    projectInfo: { readme_url: "https://example.invalid/readme" },
    measured(_observe, operation) {
      return operation();
    },
  };
}

test("verified read overrides replace every fixture-backed read handler", () => {
  const oldHandlers = Object.fromEntries(
    VERIFIED_READ_IDS.map((id) => [id, { marker: `old:${id}` }]),
  );
  oldHandlers["context.identity"] = { marker: "keep" };

  const handlers = applyVerifiedReadWorkloadOverrides(
    baseSession(),
    oldHandlers,
  );

  for (const id of VERIFIED_READ_IDS) {
    assert.notEqual(handlers[id].marker, `old:${id}`);
    assert.equal(typeof handlers[id].execute, "function");
    assert.equal(typeof handlers[id].verifyFinalState, "function");
  }
  assert.equal(handlers["context.identity"].marker, "keep");
});

test("issue inspection rejects a response that omits the benchmark-owned note", async () => {
  const calls = [];
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      calls.push(name);
      if (name === "create_issue") return { iid: 17, state: "opened" };
      if (name === "create_issue_note") return { id: 99 };
      if (name === "get_issue") return { iid: 17, state: "opened" };
      if (name === "list_issue_notes") return { data: [] };
      if (name === "update_issue")
        return { iid: args.issue_iid, state: "closed" };
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handlers = applyVerifiedReadWorkloadOverrides(session, {
    "issues.inspect-thread": { marker: "old" },
  });
  const handler = handlers["issues.inspect-thread"];

  await handler.prepare();
  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /false !== true/,
  );
  await handler.finalize();

  assert.equal(calls.includes("update_issue"), true);
});

test("discussion inspection requires one exact unresolved and one exact resolved fixture discussion", async () => {
  const calls = [];
  let sourceBranch;
  let targetBranch;
  let discussionCount = 0;
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_branch") {
        return { name: args.branch, commit: { id: "fixture-sha" } };
      }
      if (name === "compare_refs") {
        return { commit: { id: "fixture-sha" }, compare_timeout: false };
      }
      if (name === "create_commit") return { id: "fixture-sha" };
      if (name === "create_merge_request") {
        sourceBranch = args.source_branch;
        targetBranch = args.target_branch;
        return { iid: 18, state: "opened" };
      }
      if (name === "create_merge_request_discussion") {
        discussionCount += 1;
        return { id: discussionCount === 1 ? "unresolved-1" : "resolved-1" };
      }
      if (name === "resolve_merge_request_discussion") return {};
      if (name === "list_merge_request_discussions") {
        return {
          data: [
            {
              id: "unresolved-1",
              notes: [{ resolvable: true, resolved: false }],
            },
            {
              id: "resolved-1",
              notes: [{ resolvable: true, resolved: true }],
            },
          ],
        };
      }
      if (name === "get_merge_request") {
        return {
          iid: 18,
          state: "opened",
          source_branch: sourceBranch,
          target_branch: targetBranch,
        };
      }
      if (name === "update_merge_request") return { iid: 18, state: "closed" };
      if (name === "list_branches") {
        return { data: [{ name: args.search, commit: { id: "fixture-sha" } }] };
      }
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerifiedReadWorkloadOverrides(session, {
    "mr.review-discussions": { marker: "old" },
  })["mr.review-discussions"];

  await handler.prepare();
  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);
  await handler.finalize();

  const resolution = calls.find(
    ({ name }) => name === "resolve_merge_request_discussion",
  );
  assert.equal(resolution.args.discussion_id, "resolved-1");
});

test("discussion inspection rejects a fixture whose designated resolved discussion is unresolved", async () => {
  let sourceBranch;
  let targetBranch;
  let discussionCount = 0;
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_branch") {
        return { name: args.branch, commit: { id: "fixture-sha" } };
      }
      if (name === "compare_refs") {
        return { commit: { id: "fixture-sha" }, compare_timeout: false };
      }
      if (name === "create_commit") return { id: "fixture-sha" };
      if (name === "create_merge_request") {
        sourceBranch = args.source_branch;
        targetBranch = args.target_branch;
        return { iid: 19, state: "opened" };
      }
      if (name === "create_merge_request_discussion") {
        discussionCount += 1;
        return { id: discussionCount === 1 ? "unresolved-1" : "resolved-1" };
      }
      if (name === "resolve_merge_request_discussion") return {};
      if (name === "list_merge_request_discussions") {
        return {
          data: [
            {
              id: "unresolved-1",
              notes: [{ resolvable: true, resolved: false }],
            },
            {
              id: "resolved-1",
              notes: [{ resolvable: true, resolved: false }],
            },
          ],
        };
      }
      if (name === "get_merge_request") {
        return {
          iid: 19,
          state: "opened",
          source_branch: sourceBranch,
          target_branch: targetBranch,
        };
      }
      if (name === "update_merge_request") return { iid: 19, state: "closed" };
      if (name === "list_branches") {
        return { data: [{ name: args.search, commit: { id: "fixture-sha" } }] };
      }
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_branch") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerifiedReadWorkloadOverrides(session, {
    "mr.review-discussions": { marker: "old" },
  })["mr.review-discussions"];

  await handler.prepare();
  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /false !== true/,
  );
  await handler.finalize();
});

test("release inspection requires the exact benchmark-owned asset link", async () => {
  let listedLinks = [{ id: 77, name: "benchmark-readme" }];
  const session = {
    ...baseSession(),
    async call(name, args = {}) {
      if (name === "create_tag") return { name: args.tag_name };
      if (name === "create_release") return { tag_name: args.tag_name };
      if (name === "create_release_asset_link") return { id: 77 };
      if (name === "get_release") return { tag_name: args.tag_name };
      if (name === "list_release_asset_links") return { data: listedLinks };
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_release" || name === "delete_tag") return {};
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  const handler = applyVerifiedReadWorkloadOverrides(session, {
    "release.inspect": { marker: "old" },
  })["release.inspect"];

  await handler.prepare();
  await handler.execute({ observe: () => {} });
  assert.equal((await handler.verifyFinalState()).verified, true);

  listedLinks = [{ id: 76, name: "other-link" }];
  await assert.rejects(
    () => handler.execute({ observe: () => {} }),
    /false !== true/,
  );
  assert.equal((await handler.verifyFinalState()).verified, false);
  await handler.finalize();
});
