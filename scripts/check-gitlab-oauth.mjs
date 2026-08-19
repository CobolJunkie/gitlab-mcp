#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

function addIssue(issues, condition, message) {
  if (condition) {
    issues.push(message);
  }
}

function parseUrl(value, field, issues) {
  try {
    return new URL(value);
  } catch {
    issues.push(`${field} is missing or is not a valid URL.`);
    return undefined;
  }
}

export function auditGitLabOAuthMetadata(
  baseUrl,
  metadata,
  { requiredScope = "api" } = {},
) {
  const issues = [];
  const warnings = [];
  const base = parseUrl(baseUrl, "GitLab URL", issues);
  const issuer = parseUrl(metadata?.issuer, "issuer", issues);

  addIssue(issues, base?.protocol !== "https:", "GitLab URL must use HTTPS.");
  addIssue(
    issues,
    issuer?.protocol !== "https:",
    "OAuth issuer must advertise HTTPS.",
  );
  addIssue(
    issues,
    Boolean(base && issuer && base.origin !== issuer.origin),
    "OAuth issuer must use the configured GitLab origin.",
  );

  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ]) {
    const endpoint = parseUrl(metadata?.[field], field, issues);
    addIssue(
      issues,
      endpoint?.protocol !== "https:",
      `${field} must advertise HTTPS.`,
    );
  }

  addIssue(
    issues,
    !metadata?.scopes_supported?.includes(requiredScope),
    `OAuth provider must advertise the ${requiredScope} scope.`,
  );
  addIssue(
    issues,
    !metadata?.grant_types_supported?.includes("authorization_code"),
    "OAuth provider must support the authorization_code grant.",
  );
  addIssue(
    issues,
    !metadata?.grant_types_supported?.includes("refresh_token"),
    "OAuth provider must support the refresh_token grant so linked users are not forced to reauthorize when access tokens expire.",
  );
  addIssue(
    issues,
    !metadata?.code_challenge_methods_supported?.includes("S256"),
    "OAuth provider must support PKCE with S256.",
  );
  addIssue(
    issues,
    !metadata?.response_types_supported?.includes("code"),
    "OAuth provider must support the code response type.",
  );

  if (!metadata?.introspection_endpoint) {
    warnings.push(
      "No token introspection endpoint is advertised; the MCP server will validate tokens through GitLab GET /api/v4/user.",
    );
  }

  return {
    ready: issues.length === 0,
    gitlabUrl: base?.toString(),
    issuer: issuer?.toString(),
    registrationEndpoint: metadata?.registration_endpoint,
    requiredScope,
    issues,
    warnings,
  };
}

async function main() {
  const input = process.argv[2] || process.env.GITLAB_URL;
  if (!input) {
    throw new Error(
      "Pass the GitLab base URL as the first argument or set GITLAB_URL.",
    );
  }
  const base = new URL(input);
  while (base.pathname.endsWith("/")) {
    base.pathname = base.pathname.slice(0, -1);
  }
  base.search = "";
  base.hash = "";
  const discoveryUrl = new URL(
    `${base.pathname}/.well-known/oauth-authorization-server`.replace(
      /\/{2,}/g,
      "/",
    ),
    base,
  );
  const response = await fetch(discoveryUrl, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `OAuth discovery returned ${response.status} ${response.statusText}.`,
    );
  }
  const result = auditGitLabOAuthMetadata(
    base.toString(),
    await response.json(),
    {
      requiredScope: process.env.MCP_READ_ONLY === "true" ? "read_api" : "api",
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  try {
    await main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
