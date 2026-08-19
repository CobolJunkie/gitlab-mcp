import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  productionContainerConfigurationIssues,
  resolveContainerCommand,
  runEntrypoint,
} from "../../scripts/docker-entrypoint.mjs";

const isLinux = os.platform() === "linux";
const linuxOrSkip = isLinux ? test : test.skip;
const entrypointPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/docker-entrypoint.mjs",
);

const signalTestTimeoutMs = 2_000;

async function waitForMarker(marker, expected) {
  const deadline = Date.now() + signalTestTimeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(marker, "utf8").catch(() => null);
    if (value === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const value = await readFile(marker, "utf8").catch(() => null);
  assert.fail(`Timed out waiting for ${expected}; received ${value}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error("Entrypoint did not exit after forwarding signal.")),
      signalTestTimeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test("reports every missing production Docker setting before startup", () => {
  assert.deepEqual(
    productionContainerConfigurationIssues({
      NODE_ENV: "production",
      MCP_HOST: "0.0.0.0",
    }),
    [
      "MCP_PUBLIC_URL is required in production and must be the external HTTPS URL ending in /mcp.",
      "MCP_ALLOWED_HOSTS is required when MCP_HOST is 0.0.0.0 (for example, mcp.example.com).",
    ],
  );
});

test("allows fully configured production containers and non-production smoke containers", () => {
  assert.deepEqual(
    productionContainerConfigurationIssues({
      NODE_ENV: "production",
      MCP_HOST: "::",
      MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
      MCP_ALLOWED_HOSTS: "mcp.example.com",
    }),
    [],
  );
  assert.deepEqual(productionContainerConfigurationIssues({}), []);
});

test("container default arguments resolve the canonical bundle filename", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "entrypoint-config-"));
  try {
    await writeFile(
      path.join(tmpDir, "distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "gitlab",
        version: "1.2.3",
        description: "test distribution",
        license: "MIT",
        mcp: { bundle: "server/dist/custom-mcp.cjs" },
        skills: { directory: "skills" },
      }),
    );
    assert.deepEqual(await resolveContainerCommand(["--http"], tmpDir), [
      process.execPath,
      path.join(tmpDir, "server", "dist", "custom-mcp.cjs"),
      "--http",
    ]);

    const explicit = ["node", "custom-command.mjs"];
    assert.equal(await resolveContainerCommand(explicit, tmpDir), explicit);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

linuxOrSkip("entrypoint forwards SIGTERM to its child process", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "entrypoint-test-"));
  const marker = path.join(tmpDir, "sigterm-received");
  const childFile = path.join(tmpDir, "child.cjs");
  await writeFile(
    childFile,
    `const { writeFileSync } = require("fs");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "ok");
  process.exit(0);
});
writeFileSync(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`,
  );

  const helperScript = `
import { runEntrypoint } from ${JSON.stringify(`file://${entrypointPath}`)};
const exitCode = await runEntrypoint(
  ["node", ${JSON.stringify(childFile)}],
  { ...process.env, NODE_ENV: "test" },
);
process.exitCode = exitCode ?? 0;
`;

  const helperFile = path.join(tmpDir, "helper.mjs");
  await writeFile(helperFile, helperScript);

  try {
    const child = spawn("node", [helperFile], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const pid = child.pid;
    child.unref();

    // Wait for the entrypoint to start and spawn its child before sending
    // the signal, then send SIGTERM to the entrypoint process itself.
    await waitForMarker(marker, "ready");
    process.kill(pid, "SIGTERM");

    const { code, signal } = await waitForExit(child);
    assert.equal(signal, null);
    assert.equal(code, 0);
    await waitForMarker(marker, "ok");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

linuxOrSkip("entrypoint forwards SIGINT to its child process", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "entrypoint-test-"));
  const marker = path.join(tmpDir, "sigint-received");
  const childFile = path.join(tmpDir, "child.cjs");
  await writeFile(
    childFile,
    `const { writeFileSync } = require("fs");
process.on("SIGINT", () => {
  writeFileSync(${JSON.stringify(marker)}, "ok");
  process.exit(0);
});
writeFileSync(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`,
  );

  const helperScript = `
import { runEntrypoint } from ${JSON.stringify(`file://${entrypointPath}`)};
const exitCode = await runEntrypoint(
  ["node", ${JSON.stringify(childFile)}],
  { ...process.env, NODE_ENV: "test" },
);
process.exitCode = exitCode ?? 0;
`;

  const helperFile = path.join(tmpDir, "helper.mjs");
  await writeFile(helperFile, helperScript);

  try {
    const child = spawn("node", [helperFile], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const pid = child.pid;
    child.unref();

    // Wait for the entrypoint to start and spawn its child before sending
    // the signal, then send SIGINT to the entrypoint process itself.
    await waitForMarker(marker, "ready");
    process.kill(pid, "SIGINT");

    const { code, signal } = await waitForExit(child);
    assert.equal(signal, null);
    assert.equal(code, 0);
    await waitForMarker(marker, "ok");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("entrypoint exits with child exit status when child exits normally", async () => {
  const exitCode = await runEntrypoint(["node", "-e", "process.exit(0)"], {
    ...process.env,
    NODE_ENV: "test",
  });
  assert.equal(exitCode, 0);
});

test("entrypoint propagates child non-zero exit status", async () => {
  const exitCode = await runEntrypoint(["node", "-e", "process.exit(2)"], {
    ...process.env,
    NODE_ENV: "test",
  });
  assert.equal(exitCode, 2);
});
