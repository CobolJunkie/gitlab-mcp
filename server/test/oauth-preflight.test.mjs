import assert from "node:assert/strict";
import test from "node:test";

import { auditGitLabOAuthMetadata } from "../../scripts/check-gitlab-oauth.mjs";

function metadata(protocol = "https:") {
  const origin = `${protocol}//gitlab.example.com`;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    introspection_endpoint: `${origin}/oauth/introspect`,
    scopes_supported: ["api", "read_api"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

test("accepts an HTTPS GitLab OAuth provider with DCR and PKCE", () => {
  assert.deepEqual(
    auditGitLabOAuthMetadata("https://gitlab.example.com", metadata("https:")),
    {
      ready: true,
      gitlabUrl: "https://gitlab.example.com/",
      issuer: "https://gitlab.example.com/",
      registrationEndpoint: "https://gitlab.example.com/oauth/register",
      requiredScope: "api",
      issues: [],
      warnings: [],
    },
  );
});

test("rejects discovery metadata that leaks an internal HTTP external URL", () => {
  const result = auditGitLabOAuthMetadata(
    "https://gitlab.example.com",
    metadata("http:"),
  );
  assert.equal(result.ready, false);
  assert.ok(
    result.issues.some((issue) => /issuer must advertise HTTPS/.test(issue)),
  );
  assert.ok(
    result.issues.some((issue) =>
      /authorization_endpoint must advertise HTTPS/.test(issue),
    ),
  );
  assert.ok(
    result.issues.some((issue) =>
      /registration_endpoint must advertise HTTPS/.test(issue),
    ),
  );
});

test("rejects an OAuth provider that cannot refresh expired access tokens", () => {
  const value = metadata("https:");
  value.grant_types_supported = ["authorization_code"];
  const result = auditGitLabOAuthMetadata("https://gitlab.example.com", value);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => /refresh_token grant/.test(issue)));
});

test("accepts read_api as the required scope for read-only deployments", () => {
  const value = {
    ...metadata("https:"),
    scopes_supported: ["read_api"],
  };

  const result = auditGitLabOAuthMetadata("https://gitlab.example.com", value, {
    requiredScope: "read_api",
  });

  assert.equal(result.ready, true);
  assert.equal(result.requiredScope, "read_api");
});
