import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";

import { SERVER_VERSION } from "../server/src/version.mjs";
import { normalizeCanonicalDistribution } from "../shared/canonical-distribution.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPoint = fileURLToPath(
  new URL("../server/src/index.mjs", import.meta.url),
);
const distributionPath = fileURLToPath(
  new URL("../distribution.json", import.meta.url),
);

function nextDistinctPatchVersion(version, otherVersion) {
  const [major, minor, patch] = version.split("-", 1)[0].split(".");
  let nextPatch = BigInt(patch) + 1n;
  let candidate = `${major}.${minor}.${nextPatch}`;
  while (candidate === otherVersion) {
    nextPatch += 1n;
    candidate = `${major}.${minor}.${nextPatch}`;
  }
  return candidate;
}

function childEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  env.GITLAB_TOKEN = "canonical-bundle-provenance-test";
  env.GITLAB_URL = "https://gitlab.example.com";
  return env;
}

test("bare canonical bundle keeps distribution and core versions independent", async () => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "gitlab-mcp-canonical-provenance-"),
  );
  const bundlePath = path.join(tempDirectory, "gitlab-mcp.cjs");
  const canonicalSource = JSON.parse(await readFile(distributionPath, "utf8"));
  const canonical = normalizeCanonicalDistribution({
    ...canonicalSource,
    version: nextDistinctPatchVersion(canonicalSource.version, SERVER_VERSION),
  });

  try {
    await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [entryPoint],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      sourcemap: false,
      plugins: [
        {
          name: "canonical-distribution-fixture",
          setup(buildContext) {
            buildContext.onLoad(
              { filter: /distribution\.json$/ },
              async (args) => {
                if (
                  path.resolve(args.path) !== path.resolve(distributionPath)
                ) {
                  return null;
                }
                return {
                  contents: JSON.stringify(canonical),
                  loader: "json",
                };
              },
            );
          },
        },
      ],
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundlePath, "--stdio"],
      env: childEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "canonical-bundle-provenance-test",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "get_runtime_info",
        arguments: {},
      });
      assert.equal(response.isError, undefined);
      assert.deepEqual(response.structuredContent.result.plugin, {
        name: canonical.name,
        version: canonical.version,
      });
      assert.deepEqual(response.structuredContent.result.server, {
        name: "gitlab",
        version: SERVER_VERSION,
      });
      assert.notEqual(canonical.version, SERVER_VERSION);
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
