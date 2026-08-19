import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CACHE_MAX_ENTRIES,
  capabilityCacheIdentity,
  clearGitLabCapabilityCache,
  getGitLabCapabilities,
  getGitLabCapabilityCacheSize,
  normalizeCapabilityError,
} from "../src/capabilities.mjs";
import { GitLabApiError } from "../src/gitlab-client.mjs";

function apiError(status, response) {
  return new GitLabApiError(`GitLab API returned ${status}.`, {
    status,
    method: "GET",
    path: "/probe",
    response,
  });
}

function mockClient({
  baseUrl = "https://gitlab.example.com",
  token = "secret-token",
  responses = {},
} = {}) {
  const calls = [];
  return {
    baseUrl,
    token,
    calls,
    async request(path) {
      calls.push(path);
      const value = responses[String(path)];
      if (value instanceof Error) throw value;
      return { data: value ?? {} };
    },
  };
}

test.beforeEach(() => clearGitLabCapabilityCache());

test("discovers compact GitLab.com identity, version, revision, and PAT scopes", async () => {
  const client = mockClient({
    baseUrl: "https://gitlab.com",
    responses: {
      "/user": {
        id: 7,
        username: "alice",
        name: "Alice",
        state: "active",
        is_admin: false,
      },
      "/version": { version: "18.2.1", revision: "abc123" },
      "/metadata": { version: "18.2.1", revision: "abc123", enterprise: true },
      "/personal_access_tokens/self": {
        scopes: ["read_api"],
        active: true,
        expires_at: "2027-01-01",
      },
    },
  });

  const result = await getGitLabCapabilities(client, { now: 1_000 });
  assert.equal(result.instance.kind, "gitlab.com");
  assert.equal(result.instance.version, "18.2.1");
  assert.equal(result.instance.revision, "abc123");
  assert.equal(result.instance.edition, "enterprise");
  assert.deepEqual(result.authentication.scopes, ["read_api"]);
  assert.equal(result.identity.isAdmin, false);
  assert.equal(
    result.capabilities.administrator_api.state,
    "permission_required",
  );
  assert.equal(result.probes, undefined);
  assert.equal(result.cache.status, "miss");
});

test("discovers a self-managed administrator with metadata fallback", async () => {
  const client = mockClient({
    responses: {
      "/user": { id: 1, username: "root", is_admin: true },
      "/version": apiError(403, { message: "Forbidden" }),
      "/metadata": {
        version: "16.11.5-ee",
        revision: "deadbeef",
        enterprise: true,
      },
      "/personal_access_tokens/self": apiError(404, {
        message: "404 Not Found",
      }),
      "https://gitlab.example.com/oauth/token/info": apiError(404, {
        message: "404 Not Found",
      }),
    },
  });

  const result = await getGitLabCapabilities(client, {
    detailed: true,
    now: 2_000,
  });
  assert.equal(result.instance.kind, "self_managed_or_dedicated");
  assert.equal(result.instance.version, "16.11.5-ee");
  assert.equal(result.capabilities.administrator_api.state, "available");
  assert.equal(result.probes.version.status, "permission_required");
  assert.equal(
    result.probes.token.category,
    "unsupported_endpoint_or_server_version",
  );
  assert.equal(
    result.probes.oauthToken.category,
    "unsupported_endpoint_or_server_version",
  );
  assert.ok(result.notes.length > 0);
});

test("keeps version unknown when non-admin endpoints do not expose it", async () => {
  const client = mockClient({
    responses: {
      "/user": { id: 2, username: "reader" },
      "/version": apiError(403, { message: "Forbidden" }),
      "/metadata": apiError(404, { message: "404 Not Found" }),
      "/personal_access_tokens/self": apiError(401, {
        message: "Unauthorized",
      }),
      "https://gitlab.example.com/oauth/token/info": apiError(401, {
        message: "Unauthorized",
      }),
    },
  });
  const result = await getGitLabCapabilities(client, { detailed: true });
  assert.equal(result.instance.version, undefined);
  assert.equal(
    result.capabilities.version_metadata.state,
    "permission_required",
  );
  assert.equal(result.capabilities.token_scope_metadata.state, "unknown");
});

test("discovers OAuth token scopes and remaining lifetime without exposing application metadata", async () => {
  const client = mockClient({
    responses: {
      "/user": { id: 3, username: "oauth-user" },
      "/version": { version: "18.11.1" },
      "/metadata": { version: "18.11.1", enterprise: false },
      "/personal_access_tokens/self": apiError(401, {
        message: "Unauthorized",
      }),
      "https://gitlab.example.com/oauth/token/info": {
        resource_owner_id: 3,
        scope: ["openid", "email", "api"],
        expires_in: 7_200,
        created_at: 1_000,
        application: { uid: "do-not-expose" },
      },
    },
  });

  const result = await getGitLabCapabilities(client, {
    detailed: true,
    now: 10_000,
  });
  assert.equal(result.authentication.tokenType, "oauth_access_token");
  assert.deepEqual(result.authentication.scopes, ["openid", "email", "api"]);
  assert.equal(result.authentication.expiresInSeconds, 7_200);
  assert.equal(result.authentication.expiresAt, "1970-01-01T02:00:10.000Z");
  assert.equal(result.capabilities.token_scope_metadata.state, "available");
  assert.equal(
    result.capabilities.token_scope_metadata.evidence.source,
    "/oauth/token/info",
  );
  assert.doesNotMatch(JSON.stringify(result), /do-not-expose/);
  assert.equal(result.probes.oauthToken.status, "available");
});

test("preserves a self-managed GitLab URL prefix when inspecting an OAuth token", async () => {
  const client = mockClient({
    baseUrl: "https://gitlab.example.com/gitlab",
    responses: {
      "/user": { id: 3, username: "oauth-user" },
      "/personal_access_tokens/self": apiError(401, {
        message: "Unauthorized",
      }),
      "https://gitlab.example.com/gitlab/oauth/token/info": {
        scope: ["api"],
        expires_in: 3_600,
      },
    },
  });

  const result = await getGitLabCapabilities(client);
  assert.equal(result.authentication.tokenType, "oauth_access_token");
  assert.ok(
    client.calls.some(
      (path) =>
        String(path) === "https://gitlab.example.com/gitlab/oauth/token/info",
    ),
  );
});

test("reports project-native capabilities from direct permission and license evidence", async () => {
  const base = "/projects/group%2Fproject";
  const client = mockClient({
    responses: {
      "/user": { id: 7, username: "operator" },
      "/version": { version: "18.2.1" },
      "/metadata": { version: "18.2.1", enterprise: true },
      "/personal_access_tokens/self": { scopes: ["read_api"], active: true },
      [`${base}/runners?per_page=1`]: apiError(403, {
        message: "Forbidden",
      }),
      [`${base}/protected_branches?per_page=1`]: [],
      [`${base}/approval_rules?per_page=1`]: apiError(403, {
        message: "This feature is available in GitLab Premium",
      }),
      [`${base}/repository/tags?per_page=1`]: [],
      [`${base}/releases?per_page=1`]: [],
      [`${base}/pipeline_schedules?per_page=1`]: apiError(404, {
        message: "Pipeline schedules are not enabled",
      }),
    },
  });

  const result = await getGitLabCapabilities(client, {
    project: "group/project",
    detailed: true,
  });
  assert.equal(
    result.capabilities.project_runners.state,
    "permission_required",
  );
  assert.equal(result.capabilities.protected_branches.state, "available");
  assert.equal(
    result.capabilities.project_approval_rules.state,
    "permission_required",
  );
  assert.equal(result.capabilities.repository_tags.state, "available");
  assert.equal(result.capabilities.releases.state, "available");
  assert.equal(result.capabilities.pipeline_schedules.state, "unknown");
  assert.equal(result.capabilities.ci_configuration_lint.state, "unknown");
  assert.equal(result.probes.projectRunners.status, "permission_required");
  assert.equal(
    result.probes.projectApprovalRules.status,
    "permission_required",
  );
});

test("normalizes authentication, permission, unsupported, licensed, disabled, and transient failures", () => {
  assert.equal(
    normalizeCapabilityError(apiError(401, "Unauthorized")).category,
    "authentication_failure",
  );
  assert.equal(
    normalizeCapabilityError(apiError(403, "Forbidden")).category,
    "insufficient_permission",
  );
  assert.equal(
    normalizeCapabilityError(apiError(404, "Not Found")).category,
    "unsupported_endpoint_or_server_version",
  );
  // HTTP-status evidence takes priority over body text. A 403 with
  // "licensed" in the body is still a permission failure, and a 404
  // with "not enabled" is still an unsupported-endpoint signal.
  assert.equal(
    normalizeCapabilityError(
      apiError(403, "This feature is available in GitLab Ultimate"),
    ).category,
    "insufficient_permission",
  );
  assert.equal(
    normalizeCapabilityError(apiError(404, "Feature is not enabled")).category,
    "unsupported_endpoint_or_server_version",
  );
  // Text-based classification is retained when status evidence is absent.
  assert.equal(
    normalizeCapabilityError(new Error("This feature requires GitLab Ultimate"))
      .category,
    "licensed_feature_unavailable",
  );
  assert.equal(
    normalizeCapabilityError(new Error("Feature is not enabled")).category,
    "feature_disabled_or_not_configured",
  );
  assert.equal(
    normalizeCapabilityError(apiError(503, "Unavailable")).category,
    "transient_server_or_network_failure",
  );
});

test("redacts secrets from normalized discovery errors", () => {
  const normalized = normalizeCapabilityError(
    apiError(403, {
      message: "Forbidden Authorization: Bearer super-secret token=also-secret",
    }),
  );
  assert.doesNotMatch(JSON.stringify(normalized), /super-secret|also-secret/);
});

test("cache identity is stable and never contains the raw token", () => {
  const first = capabilityCacheIdentity(
    "https://gitlab.example.com",
    "raw-secret-token",
  );
  const second = capabilityCacheIdentity(
    "https://gitlab.example.com",
    "raw-secret-token",
  );
  const different = capabilityCacheIdentity(
    "https://gitlab.example.com",
    "other-token",
  );
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.notEqual(
    first,
    capabilityCacheIdentity(
      "https://gitlab.example.com",
      "raw-secret-token",
      "group/project",
    ),
  );
  assert.doesNotMatch(first, /raw-secret-token/);
});

test("cache hits, expires, refreshes, and separates authenticated identities", async () => {
  const first = mockClient({ token: "first" });
  const second = mockClient({ token: "second" });

  assert.equal(
    (await getGitLabCapabilities(first, { now: 1_000, ttlMs: 100 })).cache
      .status,
    "miss",
  );
  assert.equal(
    (await getGitLabCapabilities(first, { now: 1_050, ttlMs: 100 })).cache
      .status,
    "hit",
  );
  assert.equal(first.calls.length, 4);
  assert.equal(
    (await getGitLabCapabilities(first, { now: 1_101, ttlMs: 100 })).cache
      .status,
    "expired",
  );
  assert.equal(first.calls.length, 8);
  assert.equal(
    (
      await getGitLabCapabilities(first, {
        now: 1_102,
        ttlMs: 100,
        refresh: true,
      })
    ).cache.status,
    "refreshed",
  );
  assert.equal(first.calls.length, 12);
  assert.equal(
    (await getGitLabCapabilities(second, { now: 1_103, ttlMs: 100 })).cache
      .status,
    "miss",
  );
  assert.equal(second.calls.length, 4);
});

test("sweeps expired entries when another credential populates the cache", async () => {
  await getGitLabCapabilities(mockClient({ token: "expired-a" }), {
    now: 1_000,
    ttlMs: 100,
  });
  await getGitLabCapabilities(mockClient({ token: "expired-b" }), {
    now: 1_050,
    ttlMs: 100,
  });
  assert.equal(getGitLabCapabilityCacheSize(), 2);

  await getGitLabCapabilities(mockClient({ token: "current" }), {
    now: 1_151,
    ttlMs: 100,
  });
  assert.equal(getGitLabCapabilityCacheSize(), 1);
});

test("enforces the capability cache hard entry limit with LRU eviction", async () => {
  for (let index = 0; index <= CAPABILITY_CACHE_MAX_ENTRIES; index += 1) {
    await getGitLabCapabilities(mockClient({ token: `token-${index}` }), {
      now: 1_000 + index,
    });
  }

  assert.equal(getGitLabCapabilityCacheSize(), CAPABILITY_CACHE_MAX_ENTRIES);

  const evicted = mockClient({ token: "token-0" });
  assert.equal(
    (await getGitLabCapabilities(evicted, { now: 2_000 })).cache.status,
    "miss",
  );
  assert.equal(evicted.calls.length, 4);
});
