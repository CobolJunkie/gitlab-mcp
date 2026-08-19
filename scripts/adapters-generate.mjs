#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CLAUDE_DISTRIBUTION } from "../adapters/claude/distribution.mjs";
import { CLINE_DISTRIBUTION } from "../adapters/cline/distribution.mjs";
import { CODEX_DISTRIBUTION } from "../adapters/codex/distribution.mjs";
import { PI_DISTRIBUTION } from "../adapters/pi/distribution.mjs";
import {
  assertCanonicalDistributionResources,
  assertDistributionFiles,
  renderDistributionFiles,
} from "./lib/distribution-config.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const targetPaths = [
  "package.json",
  "package-lock.json",
  ...CODEX_DISTRIBUTION.generatedFiles,
  ...CLINE_DISTRIBUTION.generatedFiles,
  ...CLAUDE_DISTRIBUTION.generatedFiles,
  ...PI_DISTRIBUTION.generatedFiles,
];

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

const canonical = await readJson("distribution.json");
await assertCanonicalDistributionResources(rootPath, canonical);
const inputs = {
  canonical,
  packageMetadata: await readJson("package.json"),
  packageLock: await readJson("package-lock.json"),
  codexManifest: await readJson(CODEX_DISTRIBUTION.files.manifest),
  codexMcpConfig: await readJson(CODEX_DISTRIBUTION.files.mcpConfig),
  appConfig: await readJson(CODEX_DISTRIBUTION.files.appConfig),
};
const expectedFiles = renderDistributionFiles(inputs);
const actualFiles = Object.fromEntries(
  await Promise.all(
    targetPaths.map(async (path) => [path, await readText(path)]),
  ),
);

if (process.argv.includes("--check")) {
  assertDistributionFiles(actualFiles, expectedFiles);
  console.log(
    "Distribution metadata and referenced resources are synchronized.",
  );
} else {
  const changed = [];
  for (const path of targetPaths) {
    if (actualFiles[path] === expectedFiles[path]) {
      continue;
    }
    await writeFile(fileURLToPath(new URL(path, root)), expectedFiles[path]);
    changed.push(path);
  }

  if (changed.length === 0) {
    console.log("Distribution metadata is already synchronized.");
  } else {
    console.log(`Updated distribution metadata: ${changed.join(", ")}`);
  }
}
