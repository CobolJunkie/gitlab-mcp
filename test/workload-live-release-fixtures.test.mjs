import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupReleaseFixture,
  createReleaseFixture,
} from "../scripts/lib/workload-live-release-fixtures.mjs";

function mockSession(resolver = () => undefined) {
  const calls = [];
  return {
    project: 42,
    defaultBranch: "main",
    calls,
    async call(name, args = {}) {
      calls.push({ name, args });
      return resolver(name, args, calls);
    },
  };
}

function callsNamed(session, name) {
  return session.calls.filter((entry) => entry.name === name);
}

function notFound(message = "not found") {
  const error = new Error(message);
  error.result = { status: 404 };
  return error;
}

function apiFailure(status, message = `GitLab API returned ${status}`) {
  const error = new Error(message);
  error.result = { status };
  return error;
}

test("release fixture creates a tag, release, and optional asset", async () => {
  const session = mockSession((name) => {
    if (name === "create_release") return { tag_name: "bench-release" };
    if (name === "create_release_asset_link") return { id: 7 };
    return undefined;
  });

  const fixture = await createReleaseFixture(session, "bench-release", {
    assetName: "benchmark-readme",
    assetUrl: "https://example.invalid/readme",
  });

  assert.equal(fixture.tagCreated, true);
  assert.equal(fixture.releaseCreated, true);
  assert.equal(fixture.assetLink.id, 7);
  assert.equal(callsNamed(session, "create_tag").length, 1);
  assert.equal(callsNamed(session, "create_release").length, 1);
  assert.equal(callsNamed(session, "create_release_asset_link").length, 1);
});

test("release setup cleans up a tag after an ambiguous tag-create failure", async () => {
  const failure = new Error("tag create outcome ambiguous");
  const session = mockSession((name) => {
    if (name === "create_tag") throw failure;
    return undefined;
  });

  await assert.rejects(
    createReleaseFixture(session, "bench-tag-ambiguous"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_release").length, 0);
  assert.deepEqual(callsNamed(session, "delete_tag")[0].args, {
    project: 42,
    tag_name: "bench-tag-ambiguous",
    acknowledge_tag_deletion: true,
  });
});

test("definitive tag-create rejection does not claim or delete pre-existing state", async () => {
  const failure = apiFailure(409, "tag already exists");
  const session = mockSession((name) => {
    if (name === "create_tag") throw failure;
    return undefined;
  });

  await assert.rejects(
    createReleaseFixture(session, "bench-preexisting"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_release").length, 0);
  assert.equal(callsNamed(session, "delete_tag").length, 0);
});

test("definitive release-create rejection cleans only the tag without collateral authorization", async () => {
  const failure = apiFailure(400, "release rejected");
  const session = mockSession((name) => {
    if (name === "create_release") throw failure;
    return undefined;
  });

  await assert.rejects(
    createReleaseFixture(session, "bench-release-rejected"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_release").length, 0);
  assert.deepEqual(callsNamed(session, "delete_tag")[0].args, {
    project: 42,
    tag_name: "bench-release-rejected",
    acknowledge_tag_deletion: true,
  });
});

test("release setup removes a created tag when release creation fails", async () => {
  const failure = new Error("release failed");
  const session = mockSession((name) => {
    if (name === "create_release") throw failure;
    return undefined;
  });

  await assert.rejects(
    createReleaseFixture(session, "bench-partial"),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_release").length, 1);
  assert.deepEqual(callsNamed(session, "delete_tag")[0].args, {
    project: 42,
    tag_name: "bench-partial",
    acknowledge_tag_deletion: true,
    acknowledge_associated_release_deletion: true,
  });
});

test("release setup removes release and tag when asset creation fails", async () => {
  const failure = new Error("asset failed");
  const session = mockSession((name) => {
    if (name === "create_release") return { tag_name: "bench-asset" };
    if (name === "create_release_asset_link") throw failure;
    return undefined;
  });

  await assert.rejects(
    createReleaseFixture(session, "bench-asset", {
      assetName: "asset",
      assetUrl: "https://example.invalid/asset",
    }),
    (error) => error === failure,
  );
  assert.deepEqual(callsNamed(session, "delete_release")[0].args, {
    project: 42,
    tag_name: "bench-asset",
    acknowledge_release_deletion: true,
  });
  assert.deepEqual(callsNamed(session, "delete_tag")[0].args, {
    project: 42,
    tag_name: "bench-asset",
    acknowledge_tag_deletion: true,
    acknowledge_associated_release_deletion: true,
  });
});

test("release cleanup quiesces an active tag pipeline before deleting the tag", async () => {
  let pipelineReads = 0;
  const session = mockSession((name) => {
    if (name === "list_pipelines") {
      return { data: [{ id: 91, status: "running" }] };
    }
    if (name === "cancel_pipeline") return { id: 91, status: "canceling" };
    if (name === "get_pipeline") {
      pipelineReads += 1;
      return { id: 91, status: pipelineReads === 1 ? "running" : "canceled" };
    }
    return undefined;
  });

  await cleanupReleaseFixture(session, {
    tagName: "bench-active-tag",
    tagCreated: true,
    releaseCreated: false,
  });

  const cancelIndex = session.calls.findIndex(
    (entry) => entry.name === "cancel_pipeline",
  );
  const deleteIndex = session.calls.findIndex(
    (entry) => entry.name === "delete_tag",
  );
  assert.ok(cancelIndex >= 0);
  assert.ok(deleteIndex > cancelIndex);
  assert.equal(callsNamed(session, "get_pipeline").at(-1).args.pipeline_id, 91);
});

test("release cleanup attempts the tag even when release deletion fails", async () => {
  const failure = new Error("release delete failed");
  const session = mockSession((name) => {
    if (name === "delete_release") throw failure;
    return undefined;
  });

  await assert.rejects(
    cleanupReleaseFixture(session, {
      tagName: "bench-cleanup",
      tagCreated: true,
      releaseCreated: true,
    }),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_release").length, 1);
  assert.equal(callsNamed(session, "delete_tag").length, 1);
  assert.deepEqual(callsNamed(session, "delete_tag")[0].args, {
    project: 42,
    tag_name: "bench-cleanup",
    acknowledge_tag_deletion: true,
    acknowledge_associated_release_deletion: true,
  });
});

test("release cleanup treats already removed state as idempotent", async () => {
  const session = mockSession((name) => {
    if (name === "delete_release" || name === "delete_tag") {
      throw notFound();
    }
    return undefined;
  });

  await cleanupReleaseFixture(session, {
    tagName: "bench-gone",
    tagCreated: true,
    releaseCreated: true,
  });
  assert.equal(callsNamed(session, "delete_release").length, 1);
  assert.equal(callsNamed(session, "delete_tag").length, 1);
});
