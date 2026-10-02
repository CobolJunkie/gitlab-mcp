import assert from "node:assert/strict";
import test from "node:test";

import { applyLiveWorkloadOverrides } from "../scripts/lib/workload-live-overrides.mjs";

function sessionFixture() {
  return {
    project: 42,
    defaultBranch: "main",
    runId: "bench-run",
    projectInfo: { readme_url: "https://example.invalid/readme" },
  };
}

test("live workload overrides replace every owned safety-sensitive handler", () => {
  const original = {
    "issues.update-comment": { marker: "old-issue-update" },
    "mr.comment": { marker: "old-comment" },
    "mr.resolve-discussion": { marker: "old-resolve" },
    "mr.guarded-merge": { marker: "old-merge" },
    "release.inspect": { marker: "old-release" },
    "release.asset-flow": { marker: "old-asset" },
    "deployment.inspect": { marker: "old-deployment" },
    "safety.read-only-mutation": { marker: "old-read-only" },
    "safety.admission-limit": { marker: "old-admission" },
    "context.identity": { marker: "preserved" },
  };

  const handlers = applyLiveWorkloadOverrides(sessionFixture(), original);

  assert.equal(handlers, original);
  for (const id of [
    "issues.update-comment",
    "mr.comment",
    "mr.resolve-discussion",
    "mr.guarded-merge",
    "release.inspect",
    "release.asset-flow",
    "deployment.inspect",
    "safety.read-only-mutation",
    "safety.admission-limit",
  ]) {
    assert.equal(typeof handlers[id].execute, "function");
    assert.equal(handlers[id].marker, undefined);
  }
  assert.deepEqual(handlers["context.identity"], { marker: "preserved" });
});

test("issue update override verifies description and exact note", async () => {
  const calls = [];
  let description = "Disposable benchmark-owned issue.";
  const session = {
    ...sessionFixture(),
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "create_issue") {
        return { iid: 31, state: "opened", description };
      }
      if (name === "update_issue") {
        if (args.description !== undefined) description = args.description;
        const state = args.state_event === "close" ? "closed" : "opened";
        return { iid: 31, state };
      }
      if (name === "create_issue_note") return { id: 41 };
      if (name === "get_issue") {
        return { iid: 31, state: "opened", description };
      }
      if (name === "list_issue_notes") {
        return { data: [{ id: 40 }, { id: 41 }] };
      }
      return undefined;
    },
    measured(_observe, operation) {
      return operation();
    },
  };

  const handlers = applyLiveWorkloadOverrides(session, {
    "issues.update-comment": { marker: "old-issue-update" },
  });
  const handler = handlers["issues.update-comment"];

  await handler.setup({ iteration: 5 });
  await handler.execute({ observe: () => {}, iteration: 5 });
  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.forbiddenEffectsObserved, []);
  await handler.cleanup();
});

test("guarded merge override pins the created source, target, and head", async () => {
  const calls = [];
  let merged = false;
  let mergeRequestArgs;
  const session = {
    ...sessionFixture(),
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
        return { iid: 17, state: "opened", draft: false };
      }
      if (name === "get_merge_request") {
        return {
          iid: 17,
          state: merged ? "merged" : "opened",
          draft: false,
          work_in_progress: false,
          merge_status: "can_be_merged",
          detailed_merge_status: "mergeable",
          source_branch: mergeRequestArgs.source_branch,
          target_branch: mergeRequestArgs.target_branch,
          sha: "fixture-commit",
        };
      }
      if (name === "merge_merge_request") {
        merged = true;
        return { iid: 17, state: "merged" };
      }
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

  await handler.setup({ iteration: 2 });
  const createCall = calls.find(
    (entry) => entry.name === "create_merge_request",
  );
  assert.equal(createCall.args.draft, false);
  assert.equal(createCall.args.title.startsWith("Draft:"), false);

  await handler.execute({ observe: () => {} });
  const mergeCall = calls.find((entry) => entry.name === "merge_merge_request");
  assert.deepEqual(mergeCall.args, {
    project: 42,
    merge_request_iid: 17,
    sha: "fixture-commit",
    squash: false,
    should_remove_source_branch: false,
  });

  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.forbiddenEffectsObserved, []);
  await handler.cleanup();
});

test("guarded merge refuses source-head drift before the destructive call", async () => {
  const calls = [];
  let mergeRequestArgs;
  let mergeRequestReads = 0;
  const session = {
    ...sessionFixture(),
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
          draft: false,
          work_in_progress: false,
          merge_status: "can_be_merged",
          detailed_merge_status: "mergeable",
          source_branch: mergeRequestArgs.source_branch,
          target_branch: mergeRequestArgs.target_branch,
          sha: mergeRequestReads === 1 ? "fixture-commit" : "drifted-head",
        };
      }
      if (name === "merge_merge_request") {
        assert.fail("Destructive merge must not run after fixture head drift.");
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
    /pinned source, target, head, or merge-ready state/,
  );
  assert.equal(
    calls.filter((entry) => entry.name === "merge_merge_request").length,
    0,
  );
  await handler.cleanup();
});

test("comment override verifies the exact created discussion", async () => {
  const calls = [];
  const session = {
    ...sessionFixture(),
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
        return { iid: 19, state: "opened", draft: true };
      }
      if (name === "create_merge_request_discussion") {
        return { id: "created-discussion" };
      }
      if (name === "get_merge_request") {
        return { iid: 19, state: "opened" };
      }
      if (name === "list_merge_request_discussions") {
        return {
          data: [{ id: "decoy-discussion" }, { id: "created-discussion" }],
        };
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
    "mr.comment": { marker: "old-comment" },
  });
  const handler = handlers["mr.comment"];

  await handler.setup({ iteration: 4 });
  await handler.execute({ observe: () => {} });
  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.forbiddenEffectsObserved, []);
  await handler.cleanup();
});

test("resolve discussion override verifies GitLab note-level resolution state", async () => {
  const calls = [];
  let resolved = false;
  const session = {
    ...sessionFixture(),
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
        return { iid: 23, state: "opened", draft: true };
      }
      if (name === "create_merge_request_discussion") {
        return { id: "target-discussion" };
      }
      if (name === "resolve_merge_request_discussion") {
        assert.equal(args.discussion_id, "target-discussion");
        resolved = true;
        return { id: "target-discussion", resolved: true };
      }
      if (name === "get_merge_request") {
        return { iid: 23, state: "opened" };
      }
      if (name === "list_merge_request_discussions") {
        return {
          data: [
            {
              id: "decoy-discussion",
              notes: [{ resolvable: true, resolved: false }],
            },
            {
              id: "target-discussion",
              notes: [{ resolvable: true, resolved }],
            },
          ],
        };
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
    "mr.resolve-discussion": { marker: "old-resolve" },
  });
  const handler = handlers["mr.resolve-discussion"];

  await handler.setup({ iteration: 3 });
  await handler.execute({ observe: () => {} });
  const resolveCall = calls.find(
    (entry) => entry.name === "resolve_merge_request_discussion",
  );
  assert.equal(resolveCall.args.discussion_id, "target-discussion");

  const verification = await handler.verifyFinalState();
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.forbiddenEffectsObserved, []);
  await handler.cleanup();
});
