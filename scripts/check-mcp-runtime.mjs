#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { normalizeCanonicalDistribution } from "./lib/canonical-distribution.mjs";

const canonicalDistributionSource = new URL(
  "../distribution.json",
  import.meta.url,
);

export async function readExpectedDistributionVersion(
  distributionSource = canonicalDistributionSource,
) {
  const canonical = normalizeCanonicalDistribution(
    JSON.parse(await readFile(distributionSource, "utf8")),
  );
  return canonical.version;
}

export async function checkRuntimeInfo({
  endpoint,
  expectedBuildId,
  expectedToolCount,
  token,
  fetchImpl = fetch,
  distributionSource = canonicalDistributionSource,
}) {
  if (
    !endpoint ||
    !expectedBuildId ||
    !Number.isSafeInteger(expectedToolCount) ||
    !token
  ) {
    throw new Error(
      "Pass the MCP URL and set MCP_EXPECTED_BUILD_ID, MCP_EXPECTED_TOOL_COUNT, and MCP_RUNTIME_TOKEN.",
    );
  }
  const expectedVersion =
    await readExpectedDistributionVersion(distributionSource);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_runtime_info", arguments: {} },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Authenticated get_runtime_info returned HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      "Authenticated get_runtime_info returned a protocol error.",
    );
  }
  const runtime = payload.result?.structuredContent?.result;
  const actual = {
    version: runtime?.plugin?.version,
    mode: runtime?.deployment?.mode,
    readOnly: runtime?.deployment?.readOnly,
    buildId: runtime?.build?.id,
    toolCount: runtime?.toolInventory?.count,
    fingerprint: runtime?.toolInventory?.fingerprint,
  };

  const valid =
    actual.version === expectedVersion &&
    actual.mode === "http" &&
    actual.readOnly === false &&
    actual.buildId === expectedBuildId &&
    actual.toolCount === expectedToolCount &&
    /^sha256:[a-f0-9]{64}$/.test(actual.fingerprint || "");
  if (!valid) {
    throw new Error(`Runtime verification mismatch: ${JSON.stringify(actual)}`);
  }
  return { status: "match", ...actual };
}

if (process.argv[1]?.endsWith("check-mcp-runtime.mjs")) {
  try {
    const result = await checkRuntimeInfo({
      endpoint: process.argv[2],
      expectedBuildId: process.env.MCP_EXPECTED_BUILD_ID,
      expectedToolCount: Number(process.env.MCP_EXPECTED_TOOL_COUNT),
      token: process.env.MCP_RUNTIME_TOKEN,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
