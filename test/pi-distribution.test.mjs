import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_DISTRIBUTION,
  renderPiDistributionFiles,
  renderPiPackageManifest,
} from "../adapters/pi/distribution.mjs";

const CANONICAL = {
  name: "gitlab",
  version: "1.2.3",
  description: "Canonical GitLab distribution",
  license: "MIT",
  mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
  skills: { directory: "skills" },
};
const PACKAGE_METADATA = {
  dependencies: { "@modelcontextprotocol/sdk": "1.29.0" },
};

test("Pi adapter contract owns only Pi packaging surfaces", () => {
  assert.equal(PI_DISTRIBUTION.id, "pi");
  assert.equal(PI_DISTRIBUTION.artifactName, "gitlab-pi-mcp");
  assert.deepEqual(PI_DISTRIBUTION.generatedFiles, [
    "adapters/pi/package.json",
  ]);
  assert.deepEqual(PI_DISTRIBUTION.packageFiles, [
    { source: "adapters/pi/package.json", target: "package.json" },
    {
      source: "adapters/pi/extensions/gitlab-mcp.mjs",
      target: "extensions/gitlab-mcp.mjs",
    },
    { source: "adapters/pi/mcp-bridge.mjs", target: "mcp-bridge.mjs" },
    { source: "adapters/pi/README.md", target: "README.md" },
    { source: "distribution.json", target: "distribution.json" },
    { source: "LICENSE", target: "LICENSE" },
  ]);
  assert.equal(Object.isFrozen(PI_DISTRIBUTION), true);
  assert.equal(Object.isFrozen(PI_DISTRIBUTION.generatedFiles), true);
  assert.equal(Object.isFrozen(PI_DISTRIBUTION.packageFiles), true);
  assert.equal(Object.isFrozen(PI_DISTRIBUTION.files), true);
  assert.equal(Object.isFrozen(PI_DISTRIBUTION.packagePaths), true);
});

test("Pi package manifest exposes the bridge and canonical Skills", () => {
  assert.deepEqual(renderPiPackageManifest(CANONICAL, PACKAGE_METADATA), {
    name: "gitlab-pi-mcp",
    version: "1.2.3",
    description: "Canonical GitLab distribution",
    license: "MIT",
    type: "module",
    keywords: ["pi-package"],
    engines: { node: ">=22.0.0" },
    dependencies: { "@modelcontextprotocol/sdk": "1.29.0" },
    pi: {
      extensions: ["./extensions/gitlab-mcp.mjs"],
      skills: ["./skills"],
    },
  });

  const rendered = renderPiDistributionFiles({
    canonical: CANONICAL,
    packageMetadata: PACKAGE_METADATA,
  });
  assert.deepEqual(
    JSON.parse(rendered[PI_DISTRIBUTION.files.manifest]),
    renderPiPackageManifest(CANONICAL, PACKAGE_METADATA),
  );
});

test("Pi package pins the canonical root MCP SDK dependency", () => {
  assert.equal(
    renderPiPackageManifest(CANONICAL, {
      dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
    }).dependencies["@modelcontextprotocol/sdk"],
    "1.30.0",
  );

  for (const packageMetadata of [{}, { dependencies: {} }, null]) {
    assert.throws(
      () => renderPiPackageManifest(CANONICAL, packageMetadata),
      /must provide an @modelcontextprotocol\/sdk dependency/u,
    );
  }
});
