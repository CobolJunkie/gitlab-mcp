#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { SERVER_VERSION } from "../server/src/version.mjs";
import { normalizeCanonicalDistribution } from "./lib/canonical-distribution.mjs";

const execFileAsync = promisify(execFile);
const canonical = normalizeCanonicalDistribution(
  JSON.parse(
    await readFile(new URL("../distribution.json", import.meta.url), "utf8"),
  ),
);
const suffix = `${process.pid}-${Date.now()}`;
const image = `gitlab-mcp-docker-smoke:${suffix}`;
const network = `gitlab-mcp-smoke-${suffix}`;
const mock = `gitlab-mock-${suffix}`;
const appPrefix = `gitlab-mcp-${suffix}`;
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function docker(args, { allowFailure = false } = {}) {
  try {
    return await execFileAsync("docker", args, {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    });
  } catch (error) {
    if (allowFailure) {
      return {
        code: error.code,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
      };
    }
    throw new Error(
      `docker ${args.join(" ")} failed:\n${error.stderr || error.stdout || error.message}`,
    );
  }
}

const gitLabMock = `
  const { createServer } = require("node:http");
  createServer((request, response) => {
    if (request.url === "/api/v4/user") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 7, username: "docker-smoke" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  }).listen(3001, "0.0.0.0");
`;

const probe = `
  import assert from "node:assert/strict";
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const port = Number(process.env.EXPECTED_PORT);
  assert.ok(Number.isSafeInteger(port) && port > 0);
  const baseUrl = "http://mcp.example.test:" + port;
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(baseUrl + "/health");
      if (health.ok) break;
    } catch {}
    await delay(250);
  }
  assert.ok(health?.ok, "container health endpoint did not become ready");
  assert.deepEqual(await health.json(), { status: "ok", service: "gitlab-mcp" });

  let gitLab;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      gitLab = await fetch("http://gitlab-mock:3001/api/v4/user");
      if (gitLab.ok) break;
    } catch {}
    await delay(250);
  }
  assert.equal(gitLab?.status, 200);

  let ready;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      ready = await fetch(baseUrl + "/ready");
      if (ready.ok) break;
    } catch {}
    await delay(250);
  }
  assert.equal(ready?.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready", service: "gitlab-mcp" });

  const metadata = await fetch(baseUrl + "/.well-known/oauth-protected-resource");
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: "https://mcp.example.test/mcp",
    authorization_servers: ["http://gitlab-mock:3001"],
    scopes_supported: ["api"],
    resource_name: "GitLab",
    resource_documentation: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  });

  const mcp = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer docker-smoke-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcp.status, 200);
  const payload = await mcp.json();
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  assert.ok(payload.result.tools.some((tool) => tool.name === "get_runtime_info"));

  const runtimeResponse = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer docker-smoke-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_runtime_info", arguments: {} },
    }),
  });
  assert.equal(runtimeResponse.status, 200);
  const runtimePayload = await runtimeResponse.json();
  assert.equal(runtimePayload.error, undefined, JSON.stringify(runtimePayload));
  const runtime = runtimePayload.result?.structuredContent?.result;
  assert.deepEqual(runtime?.plugin, {
    name: process.env.EXPECTED_DISTRIBUTION_NAME,
    version: process.env.EXPECTED_DISTRIBUTION_VERSION,
  });
  assert.deepEqual(runtime?.server, {
    name: "gitlab",
    version: process.env.EXPECTED_SERVER_VERSION,
  });
`;

async function waitForHealthy(app) {
  let status = "starting";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const inspected = await docker(
      ["inspect", "--format", "{{.State.Health.Status}}", app],
      { allowFailure: true },
    );
    status = inspected.stdout.trim() || status;
    if (status === "healthy") {
      return;
    }
    if (status === "unhealthy") {
      break;
    }
    await delay(250);
  }
  const details = await docker(
    ["inspect", "--format", "{{json .State.Health}}", app],
    { allowFailure: true },
  );
  throw new Error(
    `Docker health check for ${app} did not become healthy (status: ${status}).\n${details.stdout}${details.stderr}`,
  );
}

async function runAppScenario({ label, port, env = [] }) {
  const app = `${appPrefix}-${label}`;
  const envArgs = env.flatMap((value) => ["--env", value]);
  await docker([
    "run",
    "--detach",
    "--name",
    app,
    "--network",
    network,
    "--add-host",
    "mcp.example.test:127.0.0.1",
    "--env",
    "NODE_ENV=development",
    "--env",
    "GITLAB_URL=http://gitlab-mock:3001",
    "--env",
    "GITLAB_ALLOW_INSECURE_HTTP=true",
    "--env",
    "MCP_HOST=0.0.0.0",
    "--env",
    "MCP_ALLOWED_HOSTS=mcp.example.test",
    "--env",
    "MCP_PUBLIC_URL=https://mcp.example.test/mcp",
    "--health-interval",
    "1s",
    "--health-timeout",
    "5s",
    "--health-start-period",
    "1s",
    "--health-retries",
    "5",
    ...envArgs,
    image,
  ]);
  try {
    await waitForHealthy(app);
    await docker([
      "exec",
      "--env",
      `EXPECTED_PORT=${port}`,
      "--env",
      `EXPECTED_DISTRIBUTION_NAME=${canonical.name}`,
      "--env",
      `EXPECTED_DISTRIBUTION_VERSION=${canonical.version}`,
      "--env",
      `EXPECTED_SERVER_VERSION=${SERVER_VERSION}`,
      app,
      "node",
      "-e",
      probe,
    ]);
  } catch (error) {
    const logs = await docker(["logs", app], { allowFailure: true });
    throw new Error(
      `${error.message}\nMCP container logs for ${label}:\n${logs.stdout}${logs.stderr}`,
    );
  } finally {
    await docker(["rm", "--force", app], { allowFailure: true });
  }
}

async function main() {
  await docker(["build", "--tag", image, "."]);

  const imageConfigResult = await docker([
    "image",
    "inspect",
    "--format",
    "{{json .Config}}",
    image,
  ]);
  const imageConfig = JSON.parse(imageConfigResult.stdout);
  assert.ok(
    !imageConfig.Env.some((value) => value.startsWith("PORT=")),
    "Docker image must not force PORT and mask the MCP_PORT fallback.",
  );
  assert.match(
    imageConfig.Healthcheck.Test.join(" "),
    /process\.env\.PORT \|\| process\.env\.MCP_PORT \|\| '3000'/,
  );
  assert.match(
    imageConfig.Healthcheck.Test.join(" "),
    /process\.env\.MCP_ALLOWED_HOSTS/,
  );

  const missingConfiguration = await docker(["run", "--rm", image], {
    allowFailure: true,
  });
  assert.notEqual(missingConfiguration.code, 0);
  assert.match(missingConfiguration.stderr, /MCP_PUBLIC_URL is required/);
  assert.match(missingConfiguration.stderr, /MCP_ALLOWED_HOSTS is required/);

  await docker(["network", "create", network]);
  await docker([
    "run",
    "--detach",
    "--name",
    mock,
    "--network",
    network,
    "--network-alias",
    "gitlab-mock",
    "node:22-alpine",
    "node",
    "-e",
    gitLabMock,
  ]);

  await runAppScenario({ label: "default", port: 3000 });
  await runAppScenario({
    label: "port",
    port: 3100,
    env: ["PORT=3100", "MCP_PORT=3200"],
  });
  await runAppScenario({
    label: "mcp-port",
    port: 3200,
    env: ["MCP_PORT=3200"],
  });
  await runAppScenario({
    label: "empty-port",
    port: 3300,
    env: ["PORT=", "MCP_PORT=3300"],
  });

  console.log("Docker image smoke test passed.");
}

try {
  await main();
} finally {
  await docker(["rm", "--force", mock], { allowFailure: true });
  await docker(["network", "rm", network], { allowFailure: true });
  await docker(["image", "rm", image], { allowFailure: true });
}
