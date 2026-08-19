import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SERVER_VERSION } from "../src/server.mjs";

async function json(relativeUrl) {
  return JSON.parse(
    await readFile(new URL(relativeUrl, import.meta.url), "utf8"),
  );
}

test("keeps canonical package, lockfile, and Codex release metadata consistent", async () => {
  const canonical = await json("../../distribution.json");
  const packageMetadata = await json("../../package.json");
  const packageLock = await json("../../package-lock.json");
  const pluginManifest = await json("../../.codex-plugin/plugin.json");
  const pluginBaseVersion = pluginManifest.version.split("+", 1)[0];

  assert.equal(packageMetadata.name, "@local/gitlab-mcp");
  assert.equal(packageMetadata.version, canonical.version);
  assert.equal(packageMetadata.description, canonical.description);
  assert.equal(packageLock.name, packageMetadata.name);
  assert.equal(packageLock.version, packageMetadata.version);
  assert.equal(packageLock.packages?.[""]?.name, packageMetadata.name);
  assert.equal(packageLock.packages?.[""]?.version, packageMetadata.version);
  assert.equal(pluginBaseVersion, canonical.version);
  assert.equal(pluginManifest.name, canonical.name);
  assert.equal(pluginManifest.description, canonical.description);
  assert.equal(pluginManifest.license, canonical.license);
  assert.equal(pluginManifest.skills, `./${canonical.skills.directory}/`);
});

test("keeps the harness-neutral core version independently versioned", () => {
  assert.match(
    SERVER_VERSION,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
});
