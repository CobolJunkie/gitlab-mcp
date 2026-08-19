#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function issue(issues, condition, message) {
  if (condition) {
    issues.push(message);
  }
}

export function auditMcpDeployment(publicUrl, { metadata, health, ready }) {
  const issues = [];
  let resource;
  try {
    resource = new URL(publicUrl);
  } catch {
    issues.push("MCP public URL is missing or invalid.");
  }

  issue(
    issues,
    resource?.protocol !== "https:",
    "MCP public URL must use HTTPS.",
  );
  issue(
    issues,
    resource && !stripTrailingSlashes(resource.pathname).endsWith("/mcp"),
    "MCP public URL path must end with /mcp.",
  );
  issue(
    issues,
    metadata?.resource !== resource?.toString(),
    "Protected-resource metadata must advertise the exact MCP public URL.",
  );
  issue(
    issues,
    !Array.isArray(metadata?.authorization_servers) ||
      metadata.authorization_servers.length === 0,
    "Protected-resource metadata must advertise an authorization server.",
  );
  for (const authorizationServer of metadata?.authorization_servers || []) {
    let url;
    try {
      url = new URL(authorizationServer);
    } catch {
      // Reported by the condition below.
    }
    issue(
      issues,
      url?.protocol !== "https:",
      "Every authorization server must advertise HTTPS.",
    );
  }
  issue(
    issues,
    !Array.isArray(metadata?.scopes_supported) ||
      metadata.scopes_supported.length === 0,
    "Protected-resource metadata must advertise at least one OAuth scope.",
  );
  issue(
    issues,
    health?.status !== "ok" || health?.service !== "gitlab-mcp",
    "The liveness endpoint did not report a healthy GitLab MCP service.",
  );
  issue(
    issues,
    ready?.status !== "ready" || ready?.service !== "gitlab-mcp",
    "The readiness endpoint did not report a ready GitLab MCP service.",
  );

  return {
    ready: issues.length === 0,
    resource: resource?.toString(),
    issues,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status} ${response.statusText}.`,
    );
  }
  return response.json();
}

async function main() {
  const input = process.argv[2] || process.env.MCP_PUBLIC_URL;
  if (!input) {
    throw new Error(
      "Pass the public MCP URL as the first argument or set MCP_PUBLIC_URL.",
    );
  }
  const resource = new URL(input);
  const origin = new URL("/", resource);
  const result = auditMcpDeployment(resource.toString(), {
    metadata: await fetchJson(
      new URL("/.well-known/oauth-protected-resource", origin),
    ),
    health: await fetchJson(new URL("/health", origin)),
    ready: await fetchJson(new URL("/ready", origin)),
  });
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
