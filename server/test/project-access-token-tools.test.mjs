import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GitLabApiError } from "../src/gitlab-client.mjs";
import { createGitLabMcpServer } from "../src/server.mjs";

const PROJECT = "group/project";
const CI_PROJECT = "group/ci-project";
const TOKEN_PATH = "/projects/group%2Fproject/access_tokens";
const VARIABLE_PATH =
  "/projects/group%2Fci-project/variables/GITLAB_INTEGRATION_DISPOSABLE_TOKEN";
const OLD_TOKEN_NAME = "old benchmark token";
const SECRET = "glpat-one-time-secret-value";

function apiError(status, method = "GET", path = TOKEN_PATH) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method,
    path,
  });
}

function token(id = 7, extra = {}) {
  return {
    id,
    user_id: 8,
    name: id === 7 ? OLD_TOKEN_NAME : `token-${id}`,
    scopes: ["api"],
    active: true,
    revoked: false,
    access_level: 40,
    ...extra,
  };
}

function variableMetadata(extra = {}) {
  return {
    key: "GITLAB_INTEGRATION_DISPOSABLE_TOKEN",
    variable_type: "env_var",
    value: "must-never-leak",
    protected: true,
    masked: true,
    hidden: true,
    raw: false,
    environment_scope: "*",
    description: "managed benchmark credential",
    ...extra,
  };
}

async function connectedPair(request, options = {}) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    ...options,
    clientFactory: () => ({
      baseUrl: "https://gitlab.example.com",
      token: "test-credential",
      request,
    }),
  });
  const client = new Client({
    name: "project-access-token-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

async function withPair(t, request, options = {}) {
  const pair = await connectedPair(request, options);
  t.after(async () => {
    await pair.client.close();
    await pair.server.close();
  });
  return pair;
}

function replacementArguments(extra = {}) {
  return {
    project: PROJECT,
    old_token_id: 7,
    expected_old_token_name: OLD_TOKEN_NAME,
    replacement_name: "replacement benchmark token",
    replacement_scopes: ["api"],
    replacement_access_level: 40,
    replacement_expires_at: "2026-10-16",
    ci_project: CI_PROJECT,
    ci_variable_key: "GITLAB_INTEGRATION_DISPOSABLE_TOKEN",
    ci_variable_environment_scope: "*",
    acknowledge_credential_replacement: true,
    acknowledge_old_token_revocation: true,
    ...extra,
  };
}

test("project access-token reads expose metadata but never token values", async (t) => {
  const { client } = await withPair(t, async (path) => {
    if (path === TOKEN_PATH) {
      return {
        data: [{ ...token(), token: "must-not-leak-from-list" }],
        pagination: { page: 1 },
      };
    }
    return { data: { ...token(), token: "must-not-leak-from-get" } };
  });

  const listed = await client.callTool({
    name: "list_project_access_tokens",
    arguments: { project: PROJECT },
  });
  const fetched = await client.callTool({
    name: "get_project_access_token",
    arguments: { project: PROJECT, token_id: 7 },
  });

  const combined = JSON.stringify({ listed, fetched });
  assert.doesNotMatch(combined, /must-not-leak/u);
  assert.equal(listed.structuredContent.result.data[0].id, 7);
  assert.equal(fetched.structuredContent.result.id, 7);
});

test("create relies on the authoritative project-token endpoint and returns the new value once", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    assert.equal(path, TOKEN_PATH);
    assert.equal(options.method, "POST");
    return { data: { ...token(17), token: SECRET } };
  });

  const response = await client.callTool({
    name: "create_project_access_token",
    arguments: {
      project: PROJECT,
      name: "benchmark replacement",
      scopes: ["api"],
      access_level: 40,
      expires_at: "2026-10-16",
    },
  });

  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.result.token, SECRET);
  assert.doesNotMatch(response.content[0].text, /glpat-/u);
  assert.equal(JSON.stringify(response).split(SECRET).length - 1, 1);
  assert.equal(calls.length, 1);
});

test("create distinguishes unconfirmed transport outcomes from confirmed GitLab failures", async () => {
  {
    const { client, server } = await connectedPair(
      async (path, options = {}) => {
        assert.equal(path, TOKEN_PATH);
        assert.equal(options.method, "POST");
        throw new Error("connection closed after request dispatch");
      },
    );
    try {
      const response = await client.callTool({
        name: "create_project_access_token",
        arguments: {
          project: PROJECT,
          name: "benchmark replacement",
          scopes: ["api"],
          expires_at: "2026-10-16",
        },
      });
      assert.equal(response.isError, true);
      assert.match(
        response.structuredContent.result.message,
        /creation could not be confirmed/u,
      );
      assert.match(
        response.structuredContent.result.message,
        /inspect project access-token metadata.*before retrying/u,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }

  {
    const { client, server } = await connectedPair(async (path) => {
      throw apiError(403, "POST", path);
    });
    try {
      const response = await client.callTool({
        name: "create_project_access_token",
        arguments: {
          project: PROJECT,
          name: "benchmark replacement",
          scopes: ["api"],
          expires_at: "2026-10-16",
        },
      });
      assert.equal(response.isError, true);
      assert.doesNotMatch(
        response.structuredContent.result.message,
        /could not be confirmed/u,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("capability discovery does not misclassify access-token self evidence as a personal token", async (t) => {
  const { client } = await withPair(t, async (path) => {
    if (path === TOKEN_PATH) return { data: [] };
    if (path === "/personal_access_tokens/self") {
      return { data: { scopes: ["api"], active: true } };
    }
    assert.fail(`Unexpected path ${path}`);
  });

  const response = await client.callTool({
    name: "get_project_access_token_capabilities",
    arguments: { project: PROJECT },
  });

  assert.equal(response.structuredContent.result.metadata.state, "available");
  assert.equal(
    response.structuredContent.result.createOrRotateOthers.state,
    "unknown",
  );
  assert.equal(
    response.structuredContent.result.createOrRotateOthers.apiScope,
    true,
  );
  assert.deepEqual(response.structuredContent.result.availability, {
    gitlabCom: "Premium or Ultimate subscription required.",
    selfManaged: "Available with any license.",
    dedicated: "Available with any license.",
  });
});

test("capability discovery distinguishes authentication rejection from permission denial", async (t) => {
  const { client } = await withPair(t, async (path) => {
    throw apiError(401, "GET", path);
  });

  const response = await client.callTool({
    name: "get_project_access_token_capabilities",
    arguments: { project: PROJECT },
  });

  assert.equal(response.structuredContent.result.metadata.state, "unavailable");
  assert.equal(
    response.structuredContent.result.createOrRotateOthers.state,
    "unavailable",
  );
  assert.match(
    response.structuredContent.result.metadata.reason,
    /401 Unauthorized/u,
  );
});

test("capability discovery keeps 404 unknown while explaining offering limits", async (t) => {
  const { client } = await withPair(t, async (path) => {
    throw apiError(404, "GET", path);
  });

  const response = await client.callTool({
    name: "get_project_access_token_capabilities",
    arguments: { project: PROJECT },
  });

  assert.equal(response.structuredContent.result.metadata.state, "unknown");
  assert.equal(
    response.structuredContent.result.createOrRotateOthers.state,
    "unknown",
  );
  assert.match(
    response.structuredContent.result.metadata.reason,
    /GitLab\.com.*Premium or Ultimate/u,
  );
});

test("rotate preflights exact token identity and keeps its new value out of text", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7`) return { data: token() };
    if (path === `${TOKEN_PATH}/7/rotate`) {
      return { data: { ...token(19), token: SECRET } };
    }
    assert.fail(`Unexpected path ${path}`);
  });

  const response = await client.callTool({
    name: "rotate_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      expected_token_name: OLD_TOKEN_NAME,
      expires_at: "2026-10-16",
      acknowledge_token_rotation: true,
    },
  });

  assert.equal(response.structuredContent.result.token, SECRET);
  assert.doesNotMatch(response.content[0].text, /glpat-/u);
  assert.deepEqual(
    calls.map(({ path, options }) => [path, options.method || "GET"]),
    [
      [`${TOKEN_PATH}/7`, "GET"],
      [`${TOKEN_PATH}/7/rotate`, "POST"],
    ],
  );
});

test("self-rotation transport ambiguity warns that the previous credential may already be invalid", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    assert.equal(path, `${TOKEN_PATH}/self/rotate`);
    assert.equal(options.method, "POST");
    throw new Error("connection closed after rotation request dispatch");
  });

  const response = await client.callTool({
    name: "rotate_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: "self",
      acknowledge_token_rotation: true,
    },
  });

  assert.equal(response.isError, true);
  assert.match(
    response.structuredContent.result.message,
    /rotation could not be confirmed/u,
  );
  assert.match(
    response.structuredContent.result.message,
    /previous token value may already be invalid/u,
  );
  assert.match(
    response.structuredContent.result.message,
    /independently authorized credential/u,
  );
  assert.equal(calls.length, 1);
});

test("numeric rotation requires and verifies the expected token name before mutation", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    return { data: token() };
  });

  const missingName = await client.callTool({
    name: "rotate_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      acknowledge_token_rotation: true,
    },
  });
  assert.equal(missingName.isError, true);
  assert.equal(calls.length, 0);

  const mismatch = await client.callTool({
    name: "rotate_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      expected_token_name: "wrong token",
      acknowledge_token_rotation: true,
    },
  });
  assert.equal(mismatch.isError, true);
  assert.deepEqual(
    calls.map(({ path, options }) => [path, options.method || "GET"]),
    [[`${TOKEN_PATH}/7`, "GET"]],
  );
});

test("revoke is idempotent for an already-absent token", async (t) => {
  const { client } = await withPair(t, async (path) => {
    throw apiError(404, "GET", path);
  });

  const response = await client.callTool({
    name: "revoke_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      expected_token_name: OLD_TOKEN_NAME,
      acknowledge_token_revocation: true,
    },
  });

  assert.deepEqual(response.structuredContent.result, {
    id: 7,
    active: false,
    revoked: true,
    outcome: "already_absent",
    changed: false,
  });
});

test("revoke rejects a token-name mismatch before destructive deletion", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    return { data: token() };
  });

  const response = await client.callTool({
    name: "revoke_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      expected_token_name: "not the old token",
      acknowledge_token_revocation: true,
    },
  });

  assert.equal(response.isError, true);
  assert.deepEqual(
    calls.map(({ path, options }) => [path, options.method || "GET"]),
    [[`${TOKEN_PATH}/7`, "GET"]],
  );
});

test("replacement workflow keeps the secret server-side and preserves CI variable settings", async (t) => {
  const calls = [];
  let variableReads = 0;
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) {
      return { data: token() };
    }
    if (path === VARIABLE_PATH && !options.method) {
      variableReads += 1;
      return { data: variableMetadata() };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return {
        data: {
          ...token(8, { name: "replacement benchmark token" }),
          token: SECRET,
        },
      };
    }
    if (path === VARIABLE_PATH && options.method === "PUT") {
      assert.deepEqual(options.body, { value: SECRET });
      return { data: variableMetadata() };
    }
    if (path === `${TOKEN_PATH}/7` && options.method === "DELETE") {
      return { data: undefined };
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, undefined);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET, "u"));
  assert.doesNotMatch(JSON.stringify(response), /must-never-leak/u);
  assert.equal(
    response.structuredContent.result.outcome,
    "replaced_and_revoked",
  );
  assert.equal(variableReads, 2);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
});

test("replacement workflow rejects a token-name mismatch before reading or changing CI", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    return { data: token() };
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments({ expected_old_token_name: "wrong token" }),
  });

  assert.equal(response.isError, true);
  assert.deepEqual(
    calls.map(({ path, options }) => [path, options.method || "GET"]),
    [[`${TOKEN_PATH}/7`, "GET"]],
  );
});

test("replacement workflow requires an existing masked and hidden exact-scope variable", async () => {
  for (const variable of [
    variableMetadata({ masked: false }),
    variableMetadata({ hidden: false }),
    variableMetadata({ environment_scope: "production" }),
  ]) {
    const calls = [];
    const { client, server } = await connectedPair(
      async (path, options = {}) => {
        calls.push({ path, options });
        if (path === `${TOKEN_PATH}/7`) return { data: token() };
        if (path === VARIABLE_PATH) return { data: variable };
        assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
      },
    );
    try {
      const response = await client.callTool({
        name: "replace_project_access_token_ci_credential",
        arguments: replacementArguments(),
      });
      assert.equal(response.isError, true);
      assert.equal(
        calls.some(({ options }) => options.method === "POST"),
        false,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("replacement without a one-time value revokes the unusable new token before changing CI", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      return { data: variableMetadata() };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return { data: token(8, { name: "replacement benchmark token" }) };
    }
    if (path === `${TOKEN_PATH}/8` && options.method === "DELETE") {
      return { data: undefined };
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.match(
    response.structuredContent.result.message,
    /did not return its one-time value; replacement cleanup succeeded/u,
  );
  assert.equal(
    calls.some(
      ({ path, options }) => path === VARIABLE_PATH && options.method === "PUT",
    ),
    false,
  );
  assert.equal(
    calls.some(
      ({ path, options }) =>
        path === `${TOKEN_PATH}/7` && options.method === "DELETE",
    ),
    false,
  );
});

test("old-token revocation failure keeps verified replacement installed without leaking it", async (t) => {
  const calls = [];
  let variableReads = 0;
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      variableReads += 1;
      return { data: variableMetadata() };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return {
        data: {
          ...token(8, { name: "replacement benchmark token" }),
          token: SECRET,
        },
      };
    }
    if (path === VARIABLE_PATH && options.method === "PUT") {
      assert.deepEqual(options.body, { value: SECRET });
      return { data: variableMetadata() };
    }
    if (path === `${TOKEN_PATH}/7` && options.method === "DELETE") {
      throw apiError(500, "DELETE", path);
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET, "u"));
  assert.match(
    response.structuredContent.result.message,
    /now references replacement project access token ID 8/u,
  );
  assert.match(
    response.structuredContent.result.message,
    /old token ID 7 could not be revoked/u,
  );
  assert.equal(variableReads, 2);
  assert.equal(
    calls.filter(
      ({ path, options }) =>
        path === `${TOKEN_PATH}/7` && options.method === "DELETE",
    ).length,
    1,
  );
});

test("ambiguous replacement creation leaves the existing CI credential untouched", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      return { data: variableMetadata() };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      throw new Error(
        "connection closed after token creation request dispatch",
      );
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.match(
    response.structuredContent.result.message,
    /could not be confirmed/u,
  );
  assert.match(
    response.structuredContent.result.message,
    /inspect project access-token metadata/u,
  );
  assert.equal(
    calls.some(
      ({ path, options }) => path === VARIABLE_PATH && options.method === "PUT",
    ),
    false,
  );
  assert.equal(
    calls.some(({ options }) => options.method === "DELETE"),
    false,
  );
});

test("ambiguous CI write outcome leaves both tokens active for reconciliation", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      return { data: variableMetadata() };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return { data: { ...token(8), token: SECRET } };
    }
    if (path === VARIABLE_PATH && options.method === "PUT") {
      throw new Error("connection closed after request dispatch");
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET, "u"));
  assert.match(
    response.structuredContent.result.message,
    /replacement and old token ID 7 remain active/u,
  );
  assert.equal(
    calls.some(({ options }) => options.method === "DELETE"),
    false,
  );
});

test("post-write verification failure leaves both tokens active for reconciliation", async (t) => {
  const calls = [];
  let variableReads = 0;
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      variableReads += 1;
      if (variableReads === 1) return { data: variableMetadata() };
      throw apiError(503, "GET", path);
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return { data: { ...token(8), token: SECRET } };
    }
    if (path === VARIABLE_PATH && options.method === "PUT") {
      return { data: variableMetadata() };
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.match(
    response.structuredContent.result.message,
    /replacement and old token ID 7 remain active/u,
  );
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET, "u"));
  assert.equal(
    calls.some(({ options }) => options.method === "DELETE"),
    false,
  );
});

test("post-write metadata drift leaves both tokens active for reconciliation", async (t) => {
  const calls = [];
  let variableReads = 0;
  const { client } = await withPair(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path === `${TOKEN_PATH}/7` && !options.method) return { data: token() };
    if (path === VARIABLE_PATH && !options.method) {
      variableReads += 1;
      return {
        data:
          variableReads === 1
            ? variableMetadata()
            : variableMetadata({ protected: false }),
      };
    }
    if (path === TOKEN_PATH && options.method === "POST") {
      return { data: { ...token(8), token: SECRET } };
    }
    if (path === VARIABLE_PATH && options.method === "PUT") {
      return { data: variableMetadata() };
    }
    assert.fail(`Unexpected request ${options.method || "GET"} ${path}`);
  });

  const response = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments(),
  });

  assert.equal(response.isError, true);
  assert.match(
    response.structuredContent.result.message,
    /replacement and old token ID 7 remain active/u,
  );
  assert.equal(
    calls.some(({ options }) => options.method === "DELETE"),
    false,
  );
});

test("invalid expiration dates and missing acknowledgements fail before dispatch", async (t) => {
  const calls = [];
  const { client } = await withPair(t, async (...args) => {
    calls.push(args);
    return { data: {} };
  });

  const invalidDate = await client.callTool({
    name: "create_project_access_token",
    arguments: {
      project: PROJECT,
      name: "invalid-date",
      scopes: ["api"],
      expires_at: "2026-02-30",
    },
  });
  const missingAck = await client.callTool({
    name: "revoke_project_access_token",
    arguments: {
      project: PROJECT,
      token_id: 7,
      expected_token_name: OLD_TOKEN_NAME,
    },
  });
  const missingScope = await client.callTool({
    name: "replace_project_access_token_ci_credential",
    arguments: replacementArguments({
      ci_variable_environment_scope: undefined,
    }),
  });

  assert.equal(invalidDate.isError, true);
  assert.equal(missingAck.isError, true);
  assert.equal(missingScope.isError, true);
  assert.equal(calls.length, 0);
});

test("read-only mode keeps token metadata tools and omits token mutations", async (t) => {
  const { client } = await withPair(t, async () => ({ data: {} }), {
    readOnly: true,
  });
  const names = new Set(
    (await client.listTools()).tools.map(({ name }) => name),
  );

  assert.equal(names.has("get_project_access_token_capabilities"), true);
  assert.equal(names.has("list_project_access_tokens"), true);
  assert.equal(names.has("get_project_access_token"), true);
  assert.equal(names.has("create_project_access_token"), false);
  assert.equal(names.has("rotate_project_access_token"), false);
  assert.equal(names.has("revoke_project_access_token"), false);
  assert.equal(names.has("replace_project_access_token_ci_credential"), false);
});
