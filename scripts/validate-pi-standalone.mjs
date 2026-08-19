#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PI_DISTRIBUTION } from "../adapters/pi/distribution.mjs";

const execFileAsync = promisify(execFile);
const rootPath = fileURLToPath(new URL("../", import.meta.url));
const standaloneExecutable = process.env.PI_STANDALONE_EXECUTABLE?.trim();
const runtimeVersion = process.env.PI_RUNTIME_VERSION?.trim();

if (!standaloneExecutable) {
  throw new Error(
    "PI_STANDALONE_EXECUTABLE must point to the official Pi standalone executable.",
  );
}

const executableStat = await stat(standaloneExecutable);
assert.ok(executableStat.isFile(), "Pi standalone executable must be a file.");

const materializedPackageRoot = join(
  rootPath,
  "release",
  PI_DISTRIBUTION.artifactName,
);
const packageStat = await stat(materializedPackageRoot);
assert.ok(
  packageStat.isDirectory(),
  "Pi package must be materialized before standalone validation.",
);

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installProductionDependencies(packageRoot) {
  await execFileAsync(
    npmExecutable(),
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 },
  );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "gitlab-pi-standalone-"));
const isolatedPackageRoot = join(temporaryRoot, "package");
const workDirectory = join(temporaryRoot, "work");
const probePath = join(temporaryRoot, "standalone-probe.mjs");

const probeSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.PI_STANDALONE_PACKAGE_ROOT;
assert.ok(packageRoot, "Standalone probe package root must be configured.");
assert.equal(
  typeof process.versions.bun,
  "string",
  "Official Pi standalone validation must execute under Bun.",
);

const canonical = JSON.parse(
  await readFile(join(packageRoot, "distribution.json"), "utf8"),
);
const extension = await import(
  pathToFileURL(join(packageRoot, "extensions/gitlab-mcp.mjs")).href
);
const tools = [];
const started = await extension.startPiMcpExtension({
  registerTool(tool) {
    tools.push(tool);
  },
});

try {
  const runtimeTool = tools.find((tool) => tool.name === "get_runtime_info");
  assert.ok(runtimeTool, "Standalone Pi bridge must register get_runtime_info.");
  const runtimeResult = await runtimeTool.execute(
    "pi-standalone-runtime-smoke",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(
    runtimeResult.details?.mcp?.structuredContent?.result?.plugin,
    { name: canonical.name, version: canonical.version },
    "Standalone Pi bridge runtime provenance must match canonical metadata.",
  );
  console.log(
    JSON.stringify({
      bunVersion: process.versions.bun,
      toolCount: tools.length,
    }),
  );
} finally {
  await started.close();
}
`;

try {
  await cp(materializedPackageRoot, isolatedPackageRoot, { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await installProductionDependencies(isolatedPackageRoot);
  await writeFile(probePath, probeSource);

  const { stdout } = await execFileAsync(standaloneExecutable, [probePath], {
    cwd: workDirectory,
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      GITLAB_TOKEN: "pi-standalone-smoke-test",
      GITLAB_URL: "https://gitlab.example.com",
      MCP_READ_ONLY: "false",
      PI_STANDALONE_PACKAGE_ROOT: isolatedPackageRoot,
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  const outputLines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.ok(
    outputLines.length > 0,
    "Standalone Pi probe must report a result.",
  );
  const summary = JSON.parse(outputLines.at(-1));
  assert.equal(typeof summary.bunVersion, "string");
  assert.ok(
    Number.isInteger(summary.toolCount) && summary.toolCount > 0,
    "Standalone Pi probe must register canonical MCP tools.",
  );

  const versionLabel = runtimeVersion ? `@${runtimeVersion}` : "";
  console.log(
    `Pi standalone validation passed: official Pi${versionLabel} Bun ${summary.bunVersion} launched ${summary.toolCount} packaged MCP tools and executed get_runtime_info.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
