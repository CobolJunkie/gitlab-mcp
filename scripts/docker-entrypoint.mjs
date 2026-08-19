#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeCanonicalDistribution,
  resolveRepositoryPath,
} from "./lib/canonical-distribution.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function productionContainerConfigurationIssues(env = process.env) {
  if (env.NODE_ENV !== "production") {
    return [];
  }

  const issues = [];
  if (!env.MCP_PUBLIC_URL) {
    issues.push(
      "MCP_PUBLIC_URL is required in production and must be the external HTTPS URL ending in /mcp.",
    );
  }
  if (
    ["0.0.0.0", "::"].includes(env.MCP_HOST || "127.0.0.1") &&
    !env.MCP_ALLOWED_HOSTS
  ) {
    issues.push(
      `MCP_ALLOWED_HOSTS is required when MCP_HOST is ${env.MCP_HOST} (for example, mcp.example.com).`,
    );
  }
  return issues;
}

export async function resolveContainerCommand(args, rootPath = pluginRoot) {
  if (!args.length) {
    throw new Error("Container entrypoint requires a command to execute.");
  }
  if (!args[0].startsWith("-")) {
    return args;
  }

  const canonical = normalizeCanonicalDistribution(
    JSON.parse(
      await readFile(path.join(rootPath, "distribution.json"), "utf8"),
    ),
  );
  return [
    process.execPath,
    resolveRepositoryPath(
      rootPath,
      canonical.mcp.bundle,
      "distribution mcp.bundle",
    ),
    ...args,
  ];
}

export async function runEntrypoint(args, env = process.env) {
  const issues = productionContainerConfigurationIssues(env);
  if (issues.length) {
    const issueList = issues.map((issue) => `- ${issue}`).join("\n");
    console.error(`Container configuration is incomplete:\n${issueList}`);
    console.error(
      "See docs/CHATGPT_DEPLOYMENT.md for the minimal secure container invocation.",
    );
    return 64;
  }

  const command = await resolveContainerCommand(args);
  const forwardedSignals = ["SIGTERM", "SIGINT"];

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });

    const listeners = new Map();
    for (const signal of forwardedSignals) {
      const handler = () => {
        if (!child.killed) {
          child.kill(signal);
        }
      };
      listeners.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("exit", () => {
      for (const [signal, handler] of listeners) {
        process.removeListener(signal, handler);
      }
    });
  });
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  try {
    process.exitCode = await runEntrypoint(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
