import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRuntimeInfo } from "../../scripts/check-mcp-runtime.mjs";

const canonicalDistribution = JSON.parse(
  await readFile(new URL("../../distribution.json", import.meta.url), "utf8"),
);
const expectedBuildId = "661f37c1c4aabd81078ee8763d17dc736eb913ee";
const runtime = {
  plugin: { version: canonicalDistribution.version },
  deployment: { mode: "http", readOnly: false },
  build: { id: expectedBuildId },
  toolInventory: { count: 175, fingerprint: `sha256:${"a".repeat(64)}` },
};

function fetchWithRuntime(value) {
  return async (_endpoint, options) => {
    assert.equal(options.headers.authorization, "Bearer private-test-token");
    assert.equal(JSON.parse(options.body).params.name, "get_runtime_info");
    return Response.json({ result: { structuredContent: { result: value } } });
  };
}

test("authenticated runtime check accepts the expected production identity", async () => {
  const result = await checkRuntimeInfo({
    endpoint: "https://mcp.example.test/mcp",
    expectedBuildId,
    expectedToolCount: 175,
    token: "private-test-token",
    fetchImpl: fetchWithRuntime(runtime),
  });

  assert.equal(result.status, "match");
  assert.equal(result.buildId, expectedBuildId);
  assert.equal(result.toolCount, 175);
  assert.equal(result.fingerprint, runtime.toolInventory.fingerprint);
});

test("authenticated runtime check follows the checked-out canonical distribution version", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "gitlab-mcp-runtime-version-"),
  );
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));

  const [major, minor, patch] = canonicalDistribution.version
    .split("-", 1)[0]
    .split(".");
  const bumpedCanonical = {
    ...canonicalDistribution,
    version: `${major}.${minor}.${BigInt(patch) + 1n}`,
  };
  const distributionSource = path.join(tempDirectory, "distribution.json");
  await writeFile(distributionSource, JSON.stringify(bumpedCanonical));

  const bumpedRuntime = {
    ...runtime,
    plugin: { version: bumpedCanonical.version },
  };
  const result = await checkRuntimeInfo({
    endpoint: "https://mcp.example.test/mcp",
    expectedBuildId,
    expectedToolCount: 175,
    token: "private-test-token",
    fetchImpl: fetchWithRuntime(bumpedRuntime),
    distributionSource,
  });

  assert.equal(result.status, "match");
  assert.equal(result.version, bumpedCanonical.version);

  await assert.rejects(
    checkRuntimeInfo({
      endpoint: "https://mcp.example.test/mcp",
      expectedBuildId,
      expectedToolCount: 175,
      token: "private-test-token",
      fetchImpl: fetchWithRuntime(runtime),
      distributionSource,
    }),
    /Runtime verification mismatch/,
  );
});

test("authenticated runtime check rejects an unexpected build or surface", async () => {
  await assert.rejects(
    checkRuntimeInfo({
      endpoint: "https://mcp.example.test/mcp",
      expectedBuildId,
      expectedToolCount: 175,
      token: "private-test-token",
      fetchImpl: fetchWithRuntime({
        ...runtime,
        build: { id: "not_configured" },
      }),
    }),
    /Runtime verification mismatch/,
  );
});
