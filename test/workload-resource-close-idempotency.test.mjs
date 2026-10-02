import assert from "node:assert/strict";
import test from "node:test";

import {
  closeIssue,
  closeMergeRequest,
  deleteBranchIfPresent,
} from "../scripts/lib/workload-live-fixtures.mjs";

function notFoundError() {
  const error = new Error("not found");
  error.result = { status: 404 };
  return error;
}

test("issue cleanup is state-aware and idempotent", async () => {
  const calls = [];
  const closedSession = {
    project: 42,
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "get_issue") return { iid: 7, state: "closed" };
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  await closeIssue(closedSession, 7);
  assert.equal(
    calls.some(({ name }) => name === "update_issue"),
    false,
  );

  const missingSession = {
    project: 42,
    async call(name) {
      assert.equal(name, "get_issue");
      throw notFoundError();
    },
  };
  await closeIssue(missingSession, 8);
});

test("issue and merge-request cleanup tolerate a delete race", async () => {
  const issueSession = {
    project: 42,
    async call(name) {
      if (name === "get_issue") return { iid: 9, state: "opened" };
      if (name === "update_issue") throw notFoundError();
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  await closeIssue(issueSession, 9);

  const mergeRequestSession = {
    project: 42,
    async call(name) {
      if (name === "get_merge_request") return { iid: 10, state: "opened" };
      if (name === "update_merge_request") throw notFoundError();
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };
  await closeMergeRequest(mergeRequestSession, 10);
});

test("missing merge requests are already clean", async () => {
  const session = {
    project: 42,
    async call(name) {
      assert.equal(name, "get_merge_request");
      throw notFoundError();
    },
  };
  await closeMergeRequest(session, 11);
});

test("branch cleanup tolerates a delete race", async () => {
  const session = {
    project: 42,
    async call(name, args = {}) {
      if (name === "list_branches") {
        return { data: [{ name: args.search }] };
      }
      if (name === "list_pipelines") return { data: [] };
      if (name === "delete_branch") throw notFoundError();
      assert.fail(`Unexpected tool call: ${name}`);
    },
  };

  await deleteBranchIfPresent(session, "mcp-bench/already-gone");
});
