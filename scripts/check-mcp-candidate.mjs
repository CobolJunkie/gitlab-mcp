#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditMcpDeployment } from "./check-mcp-deployment.mjs";

export async function fetchCandidateJson(
  url,
  { fetchImpl = fetch, createTimeoutSignal = AbortSignal.timeout } = {},
) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: createTimeoutSignal(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function checkCandidateDeployment(
  candidateUrl,
  publicUrl,
  { fetchJsonFn = fetchCandidateJson } = {},
) {
  if (!candidateUrl || !publicUrl) {
    throw new Error(
      "Pass the private candidate MCP URL and expected public MCP URL.",
    );
  }
  const candidate = new URL(candidateUrl);
  if (candidate.protocol !== "http:" || !candidate.pathname.endsWith("/mcp")) {
    throw new Error("Candidate URL must be private HTTP and end in /mcp.");
  }
  const origin = new URL("/", candidate);
  return auditMcpDeployment(publicUrl, {
    metadata: await fetchJsonFn(
      new URL("/.well-known/oauth-protected-resource", origin),
    ),
    health: await fetchJsonFn(new URL("/health", origin)),
    ready: await fetchJsonFn(new URL("/ready", origin)),
  });
}

async function main() {
  const result = await checkCandidateDeployment(
    process.argv[2],
    process.argv[3],
  );
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
