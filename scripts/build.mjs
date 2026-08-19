import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { removeStaleMcpBundles } from "./lib/bundle-output.mjs";
import {
  normalizeCanonicalDistribution,
  resolveRepositoryPath,
} from "./lib/distribution-config.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const entryPoint = fileURLToPath(
  new URL("../server/src/index.mjs", import.meta.url),
);
const outfile = resolveRepositoryPath(
  pluginRoot,
  canonical.mcp.bundle,
  "distribution mcp.bundle",
);

const options = {
  absWorkingDir: pluginRoot,
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
};

if (process.argv.includes("--check")) {
  const result = await build({ ...options, write: false });
  const generated = result.outputFiles?.[0]?.text;
  if (!generated) {
    throw new Error("Canonical MCP bundle did not produce an output file.");
  }

  const forbidden = [
    ".codex-plugin",
    "adapters/codex",
    "__CODEX_PLUGIN_METADATA__",
    "gitlab-codex-plugin",
  ];
  const leaked = forbidden.filter((value) => generated.includes(value));
  if (leaked.length > 0) {
    throw new Error(
      `Canonical MCP bundle contains harness-specific references: ${leaked.join(", ")}`,
    );
  }

  console.log("Canonical MCP bundle builds without Codex-specific references.");
} else {
  await removeStaleMcpBundles(pluginRoot, outfile);
  await mkdir(dirname(outfile), { recursive: true });
  await build(options);
}
