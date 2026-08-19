import assert from "node:assert/strict";
import test from "node:test";

import { renderDistributionFiles } from "../scripts/lib/distribution-config.mjs";

test("canonical distribution license overwrites stale generated metadata", () => {
  const canonical = {
    schemaVersion: 1,
    name: "gitlab",
    version: "1.2.3",
    description: "Canonical GitLab distribution",
    license: "MIT",
    mcp: { bundle: "server/dist/gitlab-mcp.cjs" },
    skills: { directory: "skills" },
  };
  const rendered = renderDistributionFiles({
    canonical,
    packageMetadata: {
      name: "@local/gitlab-mcp",
      version: "9.9.9",
      description: "stale",
      license: "Apache-2.0",
      dependencies: {
        "@modelcontextprotocol/sdk": "1.29.0",
      },
    },
    packageLock: {
      name: "@local/gitlab-mcp",
      version: "9.9.9",
      packages: {
        "": {
          name: "@local/gitlab-mcp",
          version: "9.9.9",
          license: "Apache-2.0",
        },
      },
    },
    codexManifest: {
      name: "stale-name",
      version: "9.9.9+codex.20260814120000",
      description: "stale",
      license: "Apache-2.0",
      skills: "./stale-skills/",
    },
    codexMcpConfig: {
      mcpServers: {
        staleName: {
          command: "node",
          args: ["${PLUGIN_ROOT}/server/dist/stale.cjs"],
        },
      },
    },
    appConfig: {
      apps: {
        staleName: {
          id: "external-app-id",
        },
      },
    },
  });

  assert.equal(JSON.parse(rendered["package.json"]).license, canonical.license);
  assert.equal(
    JSON.parse(rendered["package-lock.json"]).packages[""].license,
    canonical.license,
  );
  assert.equal(
    JSON.parse(rendered[".codex-plugin/plugin.json"]).license,
    canonical.license,
  );
});
