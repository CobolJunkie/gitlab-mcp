#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  PI_DISTRIBUTION,
  renderPiPackageManifest,
} from "../adapters/pi/distribution.mjs";
import { validateHarnessPackage } from "./harness-package-validation.mjs";
import { normalizeCanonicalDistribution } from "./lib/distribution-config.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const PI_RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_RUNTIME_VERSION = process.env.PI_RUNTIME_VERSION?.trim();
const repositoryPackageMetadata = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const repositoryCanonical = normalizeCanonicalDistribution(
  JSON.parse(await readFile(new URL("distribution.json", root), "utf8")),
);
const probeEnvironment = {
  ...process.env,
  GITLAB_TOKEN: "pi-adapter-smoke-test",
  GITLAB_URL: "https://gitlab.example.com",
  MCP_READ_ONLY: "false",
};

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createPiFixture() {
  const tools = [];
  const eventHandlers = new Map();
  return {
    eventHandlers,
    pi: {
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        eventHandlers.set(event, handler);
      },
    },
    tools,
  };
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

async function withProbeProcessEnvironment(callback) {
  const previousToken = process.env.GITLAB_TOKEN;
  const previousUrl = process.env.GITLAB_URL;
  const previousReadOnly = process.env.MCP_READ_ONLY;
  const previousSentinel = process.env.PI_UNRELATED_SECRET;
  process.env.GITLAB_TOKEN = probeEnvironment.GITLAB_TOKEN;
  process.env.GITLAB_URL = probeEnvironment.GITLAB_URL;
  process.env.MCP_READ_ONLY = probeEnvironment.MCP_READ_ONLY;
  process.env.PI_UNRELATED_SECRET = "must-not-propagate";
  try {
    return await callback();
  } finally {
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.GITLAB_URL;
    else process.env.GITLAB_URL = previousUrl;
    if (previousReadOnly === undefined) delete process.env.MCP_READ_ONLY;
    else process.env.MCP_READ_ONLY = previousReadOnly;
    if (previousSentinel === undefined) delete process.env.PI_UNRELATED_SECRET;
    else process.env.PI_UNRELATED_SECRET = previousSentinel;
  }
}

const result = await validateHarnessPackage({
  artifactName: PI_DISTRIBUTION.artifactName,
  packageFiles: PI_DISTRIBUTION.packageFiles,
  distributionMetadataPath: PI_DISTRIBUTION.files.distributionMetadata,
  harnessLabel: "Pi",
  clientNamePrefix: "pi",
  probeEnvironment,
  validateHarness: async ({
    canonical,
    packageRoot,
    rootPath,
    readPackageJson,
  }) => {
    const manifest = await readPackageJson(
      PI_DISTRIBUTION.packagePaths.manifest,
    );
    assert.deepEqual(
      manifest,
      renderPiPackageManifest(canonical, repositoryPackageMetadata),
      "Packaged Pi manifest must match canonical distribution metadata and the root MCP SDK dependency.",
    );

    return {
      canonicalServer: {
        command: process.execPath,
        args: [join(rootPath, canonical.mcp.bundle), "--stdio"],
      },
      installedServer: {
        command: process.execPath,
        args: [join(packageRoot, canonical.mcp.bundle), "--stdio"],
      },
    };
  },
});

const writeEnabledFixture = createPiFixture();
const extensionUrl = pathToFileURL(
  join(result.packageRoot, PI_DISTRIBUTION.packagePaths.extension),
);
extensionUrl.searchParams.set("validation", String(Date.now()));
const extension = await import(extensionUrl.href);
let writeEnabledLifecycle;
try {
  writeEnabledLifecycle = extension.registerPiMcpLifecycle(
    writeEnabledFixture.pi,
    { environment: probeEnvironment },
  );
  assert.equal(
    writeEnabledFixture.tools.length,
    0,
    "Pi package loading must not start the MCP session or register session-scoped tools.",
  );
  const start = writeEnabledFixture.eventHandlers.get("session_start");
  const shutdown = writeEnabledFixture.eventHandlers.get("session_shutdown");
  assert.equal(
    typeof start,
    "function",
    "Pi extension must register session_start activation.",
  );
  assert.equal(
    typeof shutdown,
    "function",
    "Pi extension must register session_shutdown cleanup.",
  );
  await start();

  assert.deepEqual(
    writeEnabledFixture.tools
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right)),
    result.tools
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right)),
    "Pi extension must register the complete canonical MCP tool inventory after session_start.",
  );
  const runtimeTool = writeEnabledFixture.tools.find(
    (tool) => tool.name === "get_runtime_info",
  );
  assert.ok(runtimeTool, "Pi extension must register get_runtime_info.");
  const runtimeResult = await runtimeTool.execute(
    "pi-adapter-runtime-smoke",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(
    runtimeResult.details?.mcp?.structuredContent?.result?.plugin,
    {
      name: repositoryCanonical.name,
      version: repositoryCanonical.version,
    },
    "Pi bridge runtime provenance must match canonical distribution metadata.",
  );

  await shutdown();
  assert.equal(
    writeEnabledLifecycle.activeSession,
    undefined,
    "Pi session shutdown must clear the active MCP session.",
  );
} finally {
  await writeEnabledLifecycle?.close().catch(() => {});
}

const readOnlyFixture = createPiFixture();
let readOnlyLifecycle;
try {
  readOnlyLifecycle = extension.registerPiMcpLifecycle(readOnlyFixture.pi, {
    environment: {
      ...probeEnvironment,
      MCP_READ_ONLY: "true",
    },
  });
  assert.equal(
    readOnlyFixture.tools.length,
    0,
    "Pi read-only package loading must remain resource-free before session_start.",
  );
  await readOnlyFixture.eventHandlers.get("session_start")();
  const expectedReadOnlyToolNames = result.tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    readOnlyFixture.tools
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right)),
    expectedReadOnlyToolNames,
    "Pi read-only package smoke must register exactly the canonical read-only MCP tool inventory.",
  );
  assert.equal(
    readOnlyFixture.tools.some((tool) => tool.name === "create_commit"),
    false,
    "Pi read-only package smoke must not expose mutation tools.",
  );
  await readOnlyFixture.eventHandlers.get("session_shutdown")();
} finally {
  await readOnlyLifecycle?.close().catch(() => {});
}

const failureClient = new Client({
  name: "pi-adapter-cleanup-smoke",
  version: repositoryCanonical.version,
});
const failureTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(result.packageRoot, repositoryCanonical.mcp.bundle), "--stdio"],
  env: extension.createPiServerEnvironment(probeEnvironment),
});
await assert.rejects(
  extension.startPiMcpExtension(
    {
      registerTool() {
        throw new Error("forced Pi registration failure");
      },
      on() {},
    },
    {
      client: failureClient,
      transport: failureTransport,
      environment: probeEnvironment,
    },
  ),
  /forced Pi registration failure/u,
);
assert.equal(
  failureTransport.pid,
  null,
  "Pi startup failure must close the spawned MCP child process.",
);

async function validateRealPiRuntime() {
  if (process.env.PI_RUNTIME_SMOKE_REQUIRED !== "true") {
    return null;
  }
  if (!PI_RUNTIME_VERSION) {
    throw new Error(
      "PI_RUNTIME_VERSION is required when PI_RUNTIME_SMOKE_REQUIRED=true.",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "gitlab-pi-runtime-"));
  const isolatedPackageRoot = join(temporaryRoot, "package");
  const workDirectory = join(temporaryRoot, "work");
  const agentDirectory = join(temporaryRoot, "agent");
  let session;
  let loadedExtension;
  try {
    await cp(result.packageRoot, isolatedPackageRoot, { recursive: true });
    await mkdir(workDirectory, { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await installProductionDependencies(isolatedPackageRoot);

    const {
      DefaultResourceLoader,
      SessionManager,
      SettingsManager,
      createAgentSession,
    } = await import(PI_RUNTIME_PACKAGE);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: workDirectory,
      agentDir: agentDirectory,
      settingsManager,
      additionalExtensionPaths: [isolatedPackageRoot],
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    await withProbeProcessEnvironment(() => loader.reload());
    const extensionsResult = loader.getExtensions();
    assert.deepEqual(
      extensionsResult.errors,
      [],
      "Current Pi must load the packaged extension without errors.",
    );
    assert.equal(
      extensionsResult.extensions.length,
      1,
      "Current Pi must discover exactly the packaged GitLab extension.",
    );
    loadedExtension = extensionsResult.extensions[0];
    assert.deepEqual(
      [...loadedExtension.tools.keys()],
      [],
      "Current Pi package loading must not create session-scoped MCP tools before session_start.",
    );
    assert.ok(
      (loadedExtension.handlers.get("session_start") ?? []).length > 0,
      "Current Pi must retain the packaged session_start handler.",
    );
    assert.equal(
      loader.getSkills().skills.length,
      result.skillDirectories.length,
      "Current Pi package loading must discover every canonical Skill.",
    );

    ({ session } = await withProbeProcessEnvironment(() =>
      createAgentSession({
        cwd: workDirectory,
        agentDir: agentDirectory,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(workDirectory),
        noTools: "builtin",
      }),
    ));
    assert.equal(
      typeof session.bindExtensions,
      "function",
      "Current Pi AgentSession must expose bindExtensions for extension lifecycle setup.",
    );
    await withProbeProcessEnvironment(() => session.bindExtensions({}));
    const activeExtensionsResult = loader.getExtensions();
    assert.deepEqual(
      activeExtensionsResult.errors,
      [],
      "Current Pi must keep the packaged extension error-free after session creation reloads resources.",
    );
    assert.equal(
      activeExtensionsResult.extensions.length,
      1,
      "Current Pi must keep exactly one live packaged GitLab extension after session creation.",
    );
    loadedExtension = activeExtensionsResult.extensions[0];
    assert.deepEqual(
      [...loadedExtension.tools.keys()].sort((left, right) =>
        left.localeCompare(right),
      ),
      result.tools
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
      "Current Pi session_start must register the complete canonical MCP tool inventory on the live extension instance.",
    );
    const activeToolNames = session
      .getActiveToolNames()
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      activeToolNames,
      result.tools
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
      "Current Pi AgentSession must activate the packaged extension tools without built-in tools.",
    );
    const wrappedRuntimeTool = session.state.tools.find(
      (tool) => tool.name === "get_runtime_info",
    );
    assert.ok(
      wrappedRuntimeTool,
      "Current Pi AgentSession must expose get_runtime_info through its wrapped tool runtime.",
    );
    const wrappedResult = await wrappedRuntimeTool.execute(
      "pi-real-runtime-smoke",
      {},
      new AbortController().signal,
    );
    assert.deepEqual(
      wrappedResult.details?.mcp?.structuredContent?.result?.plugin,
      {
        name: repositoryCanonical.name,
        version: repositoryCanonical.version,
      },
      "Current Pi wrapped tool execution must preserve canonical MCP runtime provenance.",
    );

    const shutdownHandlers =
      loadedExtension.handlers.get("session_shutdown") ?? [];
    assert.ok(
      shutdownHandlers.length > 0,
      "Current Pi must retain the packaged session_shutdown handler.",
    );
    for (const handler of shutdownHandlers) {
      await handler({ type: "session_shutdown", reason: "quit" }, undefined);
    }
    return PI_RUNTIME_VERSION;
  } finally {
    session?.dispose();
    if (loadedExtension) {
      const cleanupHandlers =
        loadedExtension.handlers.get("session_shutdown") ?? [];
      for (const handler of cleanupHandlers) {
        try {
          await handler(
            { type: "session_shutdown", reason: "quit" },
            undefined,
          );
        } catch {
          // Best-effort cleanup after the primary validation outcome is known.
        }
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const realPiVersion = await validateRealPiRuntime();
const realPiSummary = realPiVersion
  ? `; ${PI_RUNTIME_PACKAGE}@${realPiVersion} package/runtime smoke passed`
  : "";
console.log(
  `Pi package validation passed: ${PI_DISTRIBUTION.artifactName} contains ${result.skillDirectories.length} canonical Skills and registers ${writeEnabledFixture.tools.length} canonical MCP tools through the packaged extension over stdio protocol ${result.protocolVersion}; read-only inventory filtering passed; ${result.archiveName} is reproducible with ${result.checksumName}; child cleanup passed${realPiSummary}.`,
);
