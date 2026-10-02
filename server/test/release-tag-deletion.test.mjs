import assert from "node:assert/strict";
import test from "node:test";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { registerReleaseTools } from "../src/tools/release-tools.mjs";

const PROJECT = "group/project";
const TAG = "v1.2.3";
const PROJECT_PATH = "/projects/group%2Fproject";
const TAGS_PATH = `${PROJECT_PATH}/repository/tags`;
const TAG_PATH = `${TAGS_PATH}/v1.2.3`;
const RELEASE_PATH = `${PROJECT_PATH}/releases/v1.2.3`;

function registeredTools() {
  const tools = new Map();
  registerReleaseTools((name, config, handler) => {
    tools.set(name, { config, handler });
  });
  return tools;
}

function apiError(status, path, method = "GET") {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method,
    path,
  });
}

test("tag and release deletion contracts disclose GitLab's asymmetric side effect", () => {
  const tools = registeredTools();
  const deleteTag = tools.get("delete_tag");
  const deleteRelease = tools.get("delete_release");

  assert.equal(deleteTag.config.annotations.destructiveHint, true);
  assert.match(deleteTag.config.description, /associated Release/);
  assert.match(
    deleteTag.config.description,
    /acknowledge_associated_release_deletion/,
  );
  assert.ok(
    deleteTag.config.inputSchema.acknowledge_associated_release_deletion,
  );
  assert.match(deleteRelease.config.description, /preserving the Git tag/);
  assert.match(deleteRelease.config.description, /asymmetric with delete_tag/);
});

test("tag-only deletion preflights twice and verifies exact tag absence", async () => {
  const tools = registeredTools();
  const calls = [];
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? "GET" });
      if (options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted && path === TAG_PATH) {
        throw apiError(404, path);
      }
      if (deleted && path === TAGS_PATH) {
        assert.deepEqual(options.query, {
          search: `^${TAG}$`,
          page: 1,
          per_page: 1,
        });
        return { data: [], pagination: {} };
      }
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: null,
        },
      };
    },
  };

  const result = await tools.get("delete_tag").handler(client, {
    project: PROJECT,
    tag_name: TAG,
    acknowledge_tag_deletion: true,
  });

  assert.equal(result, undefined);
  assert.deepEqual(calls, [
    { path: TAG_PATH, method: "GET" },
    { path: TAG_PATH, method: "GET" },
    { path: TAG_PATH, method: "DELETE" },
    { path: TAG_PATH, method: "GET" },
    { path: TAGS_PATH, method: "GET" },
  ]);
});

test("associated Release deletion requires explicit collateral acknowledgement", async () => {
  const tools = registeredTools();
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? "GET" });
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: { tag_name: TAG, description: "release" },
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
    }),
    /acknowledge_associated_release_deletion: true/,
  );
  assert.deepEqual(calls, [{ path: TAG_PATH, method: "GET" }]);
});

test("Release association appearing between preflights blocks deletion without collateral acknowledgement", async () => {
  const tools = registeredTools();
  const calls = [];
  let reads = 0;
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? "GET" });
      if (options.method === "DELETE") {
        throw new Error(
          "DELETE must not run without collateral acknowledgement.",
        );
      }
      reads += 1;
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release:
            reads === 1
              ? null
              : { tag_name: TAG, description: "appeared concurrently" },
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
    }),
    /acknowledge_associated_release_deletion: true/,
  );
  assert.deepEqual(calls, [
    { path: TAG_PATH, method: "GET" },
    { path: TAG_PATH, method: "GET" },
  ]);
});

test("associated Release 404 requires readable-project corroboration", async () => {
  const tools = registeredTools();
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      if (path === TAG_PATH && options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted && (path === TAG_PATH || path === RELEASE_PATH)) {
        throw apiError(404, path);
      }
      if (deleted && path === TAGS_PATH) {
        return { data: [], pagination: {} };
      }
      if (deleted && path === PROJECT_PATH) {
        throw apiError(503, path);
      }
      if (path === TAG_PATH) {
        return {
          data: {
            name: TAG,
            target: "a".repeat(40),
            release: { tag_name: TAG, description: "release" },
          },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
      acknowledge_associated_release_deletion: true,
    }),
    /the associated Release returned 404 but absence could not be corroborated/,
  );
});

test("associated Release deletion verifies both tag and Release are absent", async () => {
  const tools = registeredTools();
  const calls = [];
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? "GET" });
      if (path === TAG_PATH && options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted && (path === TAG_PATH || path === RELEASE_PATH)) {
        throw apiError(404, path);
      }
      if (deleted && path === TAGS_PATH) {
        return { data: [], pagination: {} };
      }
      if (deleted && path === PROJECT_PATH) {
        return { data: { id: 7, path_with_namespace: PROJECT } };
      }
      if (path === TAG_PATH) {
        return {
          data: {
            name: TAG,
            target: "a".repeat(40),
            release: { tag_name: TAG, description: "release" },
          },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };

  await tools.get("delete_tag").handler(client, {
    project: PROJECT,
    tag_name: TAG,
    acknowledge_tag_deletion: true,
    acknowledge_associated_release_deletion: true,
  });

  assert.deepEqual(calls, [
    { path: TAG_PATH, method: "GET" },
    { path: TAG_PATH, method: "GET" },
    { path: TAG_PATH, method: "DELETE" },
    { path: TAG_PATH, method: "GET" },
    { path: TAGS_PATH, method: "GET" },
    { path: RELEASE_PATH, method: "GET" },
    { path: PROJECT_PATH, method: "GET" },
  ]);
});

test("tag deletion fails closed when GitLab does not return a definitive delete outcome", async () => {
  const tools = registeredTools();
  let reads = 0;
  const client = {
    request: async (path, options = {}) => {
      if (options.method === "DELETE") {
        throw apiError(500, path, "DELETE");
      }
      reads += 1;
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: null,
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
    }),
    /Tag deletion outcome is ambiguous/,
  );
  assert.equal(reads, 2);
});

test("tag deletion rejects a successful DELETE when the exact tag remains present", async () => {
  const tools = registeredTools();
  const client = {
    request: async (path, options = {}) => {
      if (options.method === "DELETE") {
        return { data: undefined };
      }
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: null,
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
    }),
    /the tag is still present or was recreated concurrently/,
  );
});

test("tag deletion rejects success when the preflighted associated Release remains", async () => {
  const tools = registeredTools();
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      if (path === TAG_PATH && options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted && path === TAG_PATH) {
        throw apiError(404, path);
      }
      if (deleted && path === TAGS_PATH) {
        return { data: [], pagination: {} };
      }
      if (deleted && path === RELEASE_PATH) {
        return { data: { tag_name: TAG, name: "still here" } };
      }
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: { tag_name: TAG, description: "release" },
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
      acknowledge_associated_release_deletion: true,
    }),
    /the associated Release is still present or was recreated concurrently/,
  );
});

test("tag deletion fails closed when a direct 404 cannot be corroborated", async () => {
  const tools = registeredTools();
  let deleted = false;
  const client = {
    request: async (path, options = {}) => {
      if (path === TAG_PATH && options.method === "DELETE") {
        deleted = true;
        return { data: undefined };
      }
      if (deleted && path === TAG_PATH) {
        throw apiError(404, path);
      }
      if (deleted && path === TAGS_PATH) {
        throw apiError(404, path);
      }
      return {
        data: {
          name: TAG,
          target: "a".repeat(40),
          release: null,
        },
      };
    },
  };

  await assert.rejects(
    tools.get("delete_tag").handler(client, {
      project: PROJECT,
      tag_name: TAG,
      acknowledge_tag_deletion: true,
    }),
    /returned 404 but absence could not be corroborated/,
  );
});
