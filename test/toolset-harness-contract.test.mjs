import assert from "node:assert/strict";
import test from "node:test";

import { expectedClaudeMcpServer } from "../adapters/claude/distribution.mjs";
import { expectedClineMcpServer } from "../adapters/cline/distribution.mjs";
import { expectedCodexMcpServer } from "../adapters/codex/distribution.mjs";
import {
  createPiServerEnvironment,
  createPiServerLaunch,
} from "../adapters/pi/extensions/gitlab-mcp.mjs";

const CANONICAL = Object.freeze({
  name: "gitlab",
  version: "0.1.1",
  mcp: Object.freeze({ bundle: "server/dist/gitlab-mcp.cjs" }),
});

function assertCanonicalBundleLaunch(launch) {
  assert.equal(launch.command, "node");
  assert.ok(
    launch.args.some((argument) =>
      argument.endsWith(`/${CANONICAL.mcp.bundle}`),
    ),
  );
  assert.equal(launch.args.at(-1), "--stdio");
}

test("Codex, Claude Code, and Cline launch the canonical core bundle", () => {
  assertCanonicalBundleLaunch(expectedCodexMcpServer(CANONICAL));
  assertCanonicalBundleLaunch(expectedClaudeMcpServer(CANONICAL));
  assertCanonicalBundleLaunch(expectedClineMcpServer(CANONICAL));
});

test("Pi launches the same canonical bundle and forwards core toolset selection", () => {
  const runtime = { execPath: "node", versions: {} };
  const launch = createPiServerLaunch(
    CANONICAL,
    { MCP_TOOLSETS: "context,repository" },
    runtime,
  );

  assert.equal(launch.command, "node");
  assert.ok(launch.args[0].endsWith(CANONICAL.mcp.bundle));
  assert.equal(launch.args[1], "--stdio");
  assert.equal(launch.env.MCP_TOOLSETS, "context,repository");
});

test("Pi environment allowlist preserves toolsets without widening secret propagation", () => {
  const environment = createPiServerEnvironment({
    MCP_TOOLSETS: "context,issues",
    UNRELATED_SECRET: "must-not-propagate",
  });

  assert.equal(environment.MCP_TOOLSETS, "context,issues");
  assert.equal(environment.UNRELATED_SECRET, undefined);
});
