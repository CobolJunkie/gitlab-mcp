import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { registerMcpTools } from "../mcp-bridge.mjs";

const packageRoot = new URL("../", import.meta.url);
const PI_SERVER_ENVIRONMENT_KEYS = Object.freeze([
  "GITLAB_URL",
  "GITLAB_TOKEN",
  "GITLAB_PRIVATE_TOKEN",
  "GITLAB_ALLOW_INSECURE_HTTP",
  "MCP_READ_ONLY",
  "MCP_BUILD_ID",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function createPiServerEnvironment(environment = process.env) {
  const childEnvironment = { ...getDefaultEnvironment() };
  delete childEnvironment.BUN_BE_BUN;
  for (const key of PI_SERVER_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === "string") {
      childEnvironment[key] = environment[key];
    }
  }
  return childEnvironment;
}

async function readCanonicalDistribution() {
  return JSON.parse(
    await readFile(new URL("distribution.json", packageRoot), "utf8"),
  );
}

function canonicalBundlePath(canonical) {
  if (typeof canonical?.mcp?.bundle !== "string" || !canonical.mcp.bundle) {
    throw new TypeError(
      "Pi package canonical MCP bundle path must be a string.",
    );
  }
  return fileURLToPath(new URL(canonical.mcp.bundle, packageRoot));
}

function runtimeExecutable(runtime) {
  if (typeof runtime?.execPath !== "string" || !runtime.execPath) {
    throw new TypeError(
      "Pi runtime executable path must be a non-empty string.",
    );
  }
  return runtime.execPath;
}

export function createPiServerLaunch(
  canonical,
  environment = process.env,
  runtime = process,
) {
  const childEnvironment = createPiServerEnvironment(environment);
  if (typeof runtime?.versions?.bun === "string") {
    // Pi's standalone distribution is a Bun-compiled executable. Without this
    // override, reusing process.execPath would relaunch Pi instead of executing
    // the packaged MCP bundle as a JavaScript entrypoint.
    childEnvironment.BUN_BE_BUN = "1";
  }

  return {
    command: runtimeExecutable(runtime),
    args: [canonicalBundlePath(canonical), "--stdio"],
    env: childEnvironment,
  };
}

function createClose(client) {
  let closePromise;
  return () => {
    closePromise ??= Promise.resolve().then(() => client.close());
    return closePromise;
  };
}

function defaultClient(canonical) {
  return new Client({
    name: PI_CLIENT_NAME,
    version: canonical.version,
  });
}

function defaultTransport(canonical, environment) {
  return new StdioClientTransport(createPiServerLaunch(canonical, environment));
}

export async function startPiMcpExtension(
  pi,
  {
    canonical: canonicalInput,
    client: clientInput,
    transport: transportInput,
    createClient = defaultClient,
    createTransport = defaultTransport,
    environment = process.env,
  } = {},
) {
  const canonical = canonicalInput ?? (await readCanonicalDistribution());
  const client = clientInput ?? createClient(canonical);
  const transport = transportInput ?? createTransport(canonical, environment);
  const close = createClose(client);

  try {
    await client.connect(transport);
    const tools = await registerMcpTools(pi, client);
    return { close, tools };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export function registerPiMcpLifecycle(pi, options = {}) {
  let activeSession;
  let startPromise;

  const start = async () => {
    if (activeSession) return activeSession;
    if (startPromise) return startPromise;

    startPromise = startPiMcpExtension(pi, options)
      .then((started) => {
        activeSession = started;
        return started;
      })
      .finally(() => {
        startPromise = undefined;
      });
    return startPromise;
  };

  const close = async () => {
    if (startPromise) {
      await startPromise.catch(() => {});
    }
    const session = activeSession;
    activeSession = undefined;
    await session?.close();
  };

  pi.on("session_start", start);
  pi.on("session_shutdown", close);

  return {
    close,
    start,
    get activeSession() {
      return activeSession;
    },
  };
}

export const PI_CLIENT_NAME = "gitlab-pi-mcp";

export default function gitLabMcpPiExtension(pi) {
  registerPiMcpLifecycle(pi);
}
