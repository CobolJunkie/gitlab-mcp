#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const image = `gitlab-mcp-docker-smoke:${suffix}`;
const network = `gitlab-mcp-smoke-${suffix}`;
const mock = `gitlab-mock-${suffix}`;
const app = `gitlab-mcp-${suffix}`;

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
  const baseUrl = "http://mcp.example.test:3000";
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
`;

async function main() {
  await docker(["build", "--tag", image, "."]);

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
    image,
  ]);
  try {
    await docker(["exec", app, "node", "-e", probe]);
  } catch (error) {
    const logs = await docker(["logs", app], { allowFailure: true });
    throw new Error(
      `${error.message}\nMCP container logs:\n${logs.stdout}${logs.stderr}`,
    );
  }
  console.log("Docker image smoke test passed.");
}

try {
  await main();
} finally {
  await docker(["rm", "--force", app], { allowFailure: true });
  await docker(["rm", "--force", mock], { allowFailure: true });
  await docker(["network", "rm", network], { allowFailure: true });
  await docker(["image", "rm", image], { allowFailure: true });
}
