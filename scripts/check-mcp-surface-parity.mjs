#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkRemoteSurfaceParity } from "./lib/mcp-surface-parity.mjs";

function usage() {
  return [
    "Usage: npm run check:mcp-surface-parity -- <https://host/mcp> [--read-only] [--allow-insecure-http]",
    "",
    "Set MCP_SURFACE_PARITY_TOKEN to a short-lived bearer token when the endpoint requires authentication.",
    "The token is read from the environment and is never included in the report.",
  ].join("\n");
}

export function parseSurfaceParityArgs(
  argv,
  { readOnly = process.env.MCP_READ_ONLY === "true" } = {},
) {
  let endpoint;
  let resolvedReadOnly = readOnly;
  let allowInsecureHttp = false;
  for (const arg of argv) {
    if (arg === "--read-only") {
      resolvedReadOnly = true;
    } else if (arg === "--allow-insecure-http") {
      allowInsecureHttp = true;
    } else if (!arg.startsWith("-") && !endpoint) {
      endpoint = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!endpoint) throw new Error("Remote MCP endpoint is required.");
  return { endpoint, readOnly: resolvedReadOnly, allowInsecureHttp };
}

export async function runSurfaceParityCheck(
  argv,
  {
    readOnly = process.env.MCP_READ_ONLY === "true",
    token = process.env.MCP_SURFACE_PARITY_TOKEN,
    checkRemote = checkRemoteSurfaceParity,
  } = {},
) {
  const args = parseSurfaceParityArgs(argv, { readOnly });
  return checkRemote({
    ...args,
    token,
  });
}

async function main() {
  try {
    const report = await runSurfaceParityCheck(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "match") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `MCP surface parity check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(usage());
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  await main();
}
