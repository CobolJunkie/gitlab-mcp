import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCandidate,
  deployCommit,
  promoteCandidate,
  recoverDeployment,
  validateCurrentDeployment,
} from "../scripts/deploy-production.mjs";

const currentCommit = "c".repeat(40);
const priorCommit = "b".repeat(40);

function productionContainer(commit = priorCommit) {
  return {
    Config: { Env: [`MCP_BUILD_ID=${commit}`] },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }],
      },
    },
    State: { Running: true },
  };
}

function envFrom(container) {
  return Object.fromEntries(
    (container.Config.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

test("current deployment validation exercises deployment, parity, and runtime checks", () => {
  const commands = [];
  const environments = [];
  const logs = [];

  validateCurrentDeployment(
    {
      commit: currentCommit,
      release: "/srv/gitlab-mcp/releases/current",
      normalizedPublicUrl: "https://mcp.example.com/mcp",
      parityToken: "test-token",
      tempDirectory: "/tmp/deployment",
    },
    {
      runDocker(args) {
        commands.push(args);
        if (
          args.some((arg) => String(arg).includes("check:mcp-surface-parity"))
        ) {
          return [
            "candidate diagnostics",
            JSON.stringify({
              status: "match",
              canonical: { count: 175 },
              remote: { fingerprint: "sha256:remote" },
            }),
          ].join("\n");
        }
        return "";
      },
      writeEnvironmentFile(directory, name, environment) {
        environments.push({ directory, name, environment });
        return `${directory}/${name}`;
      },
      log(line) {
        logs.push(JSON.parse(line));
      },
    },
  );

  assert.equal(commands.length, 3);
  assert.ok(
    commands[0].some((arg) => String(arg).includes("check:mcp-deployment")),
  );
  assert.ok(
    commands[1].some((arg) => String(arg).includes("check:mcp-surface-parity")),
  );
  assert.ok(commands[2].includes("scripts/check-mcp-runtime.mjs"));
  assert.deepEqual(environments, [
    {
      directory: "/tmp/deployment",
      name: "current-parity.env",
      environment: { MCP_SURFACE_PARITY_TOKEN: "test-token" },
    },
    {
      directory: "/tmp/deployment",
      name: "current-runtime.env",
      environment: {
        MCP_RUNTIME_TOKEN: "test-token",
        MCP_EXPECTED_BUILD_ID: currentCommit,
        MCP_EXPECTED_TOOL_COUNT: "175",
      },
    },
  ]);
  assert.deepEqual(logs, [
    {
      status: "already_current",
      buildId: currentCommit,
      toolCount: 175,
      runtimeFingerprint: "sha256:remote",
    },
  ]);
});

test("candidate validation exercises private deployment, parity, and runtime checks", () => {
  const commands = [];
  const environments = [];
  const waited = [];

  const toolCount = createCandidate(
    {
      commit: currentCommit,
      release: "/srv/gitlab-mcp/releases/current",
      image: `gitlab-mcp:sha-${currentCommit}`,
      candidateName: `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
      hostName: "mcp.example.com",
      hostIp: "127.0.0.1",
      runtimeEnvFile: "/tmp/deployment/runtime.env",
      normalizedPublicUrl: "https://mcp.example.com/mcp",
      parityToken: "test-token",
      tempDirectory: "/tmp/deployment",
    },
    {
      runDocker(args) {
        commands.push(args);
        if (args[0] === "rm") {
          throw new Error("stale candidate absent");
        }
        if (
          args.some((arg) => String(arg).includes("check:mcp-surface-parity"))
        ) {
          return [
            "candidate diagnostics",
            JSON.stringify({
              status: "match",
              canonical: { count: 175 },
              remote: { fingerprint: "sha256:candidate" },
            }),
          ].join("\n");
        }
        return "";
      },
      waitForReady(name) {
        waited.push(name);
      },
      inspectContainer() {
        return {
          NetworkSettings: {
            Ports: { "3000/tcp": [{ HostPort: "49152" }] },
          },
        };
      },
      writeEnvironmentFile(directory, name, environment) {
        environments.push({ directory, name, environment });
        return `${directory}/${name}`;
      },
    },
  );

  assert.equal(toolCount, 175);
  assert.deepEqual(waited, [
    `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
  ]);
  assert.equal(commands[0][0], "rm");
  assert.equal(commands[1][0], "run");
  assert.ok(commands[1].includes("127.0.0.1::3000"));
  assert.ok(commands[2].includes("scripts/check-mcp-candidate.mjs"));
  assert.ok(commands[2].includes("http://mcp.example.com:49152/mcp"));
  assert.ok(
    commands[3].some((arg) => String(arg).includes("check:mcp-surface-parity")),
  );
  assert.ok(commands[4].includes("scripts/check-mcp-runtime.mjs"));
  assert.deepEqual(environments, [
    {
      directory: "/tmp/deployment",
      name: "parity.env",
      environment: {
        MCP_SURFACE_PARITY_TOKEN: "test-token",
        MCP_RUNTIME_TOKEN: "test-token",
        MCP_EXPECTED_BUILD_ID: currentCommit,
      },
    },
    {
      directory: "/tmp/deployment",
      name: "candidate-validation.env",
      environment: {
        MCP_RUNTIME_TOKEN: "test-token",
        MCP_EXPECTED_BUILD_ID: currentCommit,
        MCP_EXPECTED_TOOL_COUNT: "175",
      },
    },
  ]);
});

test("candidate parity mismatch fails before runtime validation", () => {
  let runtimeChecked = false;

  assert.throws(
    () =>
      createCandidate(
        {
          commit: currentCommit,
          release: "/srv/gitlab-mcp/releases/current",
          image: `gitlab-mcp:sha-${currentCommit}`,
          candidateName: "gitlab-mcp-candidate-test",
          hostName: "mcp.example.com",
          hostIp: "127.0.0.1",
          runtimeEnvFile: "/tmp/deployment/runtime.env",
          normalizedPublicUrl: "https://mcp.example.com/mcp",
          parityToken: "test-token",
          tempDirectory: "/tmp/deployment",
        },
        {
          runDocker(args) {
            if (
              args.some((arg) =>
                String(arg).includes("check:mcp-surface-parity"),
              )
            ) {
              return JSON.stringify({ status: "mismatch" });
            }
            if (args.includes("scripts/check-mcp-runtime.mjs")) {
              runtimeChecked = true;
            }
            return "";
          },
          waitForReady() {},
          inspectContainer() {
            return {
              NetworkSettings: {
                Ports: { "3000/tcp": [{ HostPort: "49152" }] },
              },
            };
          },
          writeEnvironmentFile(directory, name) {
            return `${directory}/${name}`;
          },
        },
      ),
    /Candidate MCP surface did not match repository source/u,
  );
  assert.equal(runtimeChecked, false);
});

test("promotion performs the destructive transition only after candidate validation", () => {
  const state = { productionPromoted: false, deploymentValidated: false };
  const commands = [];
  const logs = [];

  promoteCandidate(
    {
      state,
      commit: currentCommit,
      priorCommit,
      production: productionContainer(),
      candidateName: `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
      image: `gitlab-mcp:sha-${currentCommit}`,
      rollbackName: "gitlab-mcp-rollback-123",
      runtimeEnvFile: "/tmp/runtime.env",
      release: "/srv/gitlab-mcp/releases/current",
      parityToken: "test-token",
      toolCount: 175,
      normalizedPublicUrl: "https://mcp.example.com/mcp",
      tempDirectory: "/tmp/deployment",
    },
    {
      runCommand(command, args) {
        commands.push([command, ...args]);
        return "";
      },
      runDocker(args) {
        commands.push(["docker", ...args]);
        return "";
      },
      waitForReady() {},
      inspectContainer() {
        return {
          Config: { Env: [`MCP_BUILD_ID=${currentCommit}`] },
          Image: "sha256:replacement",
        };
      },
      readContainerEnvironment: envFrom,
      getContainerPort() {
        return { hostIp: "127.0.0.1", hostPort: "3000" };
      },
      writeEnvironmentFile() {
        return "/tmp/deployment/validation.env";
      },
      pruneState() {
        return {
          prunedContainers: [],
          prunedReleases: [],
          retainedReleases: [],
          prunedImages: [],
          retainedImages: [],
        };
      },
      log(line) {
        logs.push(JSON.parse(line));
      },
    },
  );

  assert.equal(state.productionPromoted, true);
  assert.equal(state.deploymentValidated, true);

  const stopCandidate = commands.findIndex(
    (command) =>
      command[0] === "docker" &&
      command[1] === "stop" &&
      command.at(-1)?.startsWith("gitlab-mcp-candidate-"),
  );
  const renameProduction = commands.findIndex(
    (command) =>
      command[0] === "docker" &&
      command[1] === "rename" &&
      command[2] === "gitlab-mcp",
  );
  const startReplacement = commands.findIndex(
    (command) =>
      command[0] === "docker" &&
      command[1] === "run" &&
      command.includes("gitlab-mcp"),
  );

  assert.ok(stopCandidate >= 0);
  assert.ok(renameProduction > stopCandidate);
  assert.ok(startReplacement > renameProduction);
  assert.deepEqual(logs, [
    {
      status: "deployed",
      buildId: currentCommit,
      priorBuildId: priorCommit,
      toolCount: 175,
      imageId: "sha256:replacement",
      rollbackContainer: "gitlab-mcp-rollback-123",
      retention: {
        prunedContainers: [],
        prunedReleases: [],
        retainedReleases: [],
        prunedImages: [],
        retainedImages: [],
      },
    },
  ]);
});

test("recovery restores rollback when replacement production is absent", () => {
  const commands = [];

  recoverDeployment(
    {
      productionPromoted: true,
      rollbackName: "gitlab-mcp-rollback-123",
    },
    {
      runDocker(args) {
        commands.push(args);
        if (
          args[0] === "container" &&
          args[1] === "inspect" &&
          args[2] === "gitlab-mcp"
        ) {
          throw new Error("replacement absent");
        }
        return "";
      },
      now: () => 456,
      errorLog() {
        assert.fail("rollback should succeed");
      },
    },
  );

  assert.deepEqual(commands, [
    ["container", "inspect", "gitlab-mcp"],
    ["container", "inspect", "gitlab-mcp-rollback-123"],
    ["rename", "gitlab-mcp-rollback-123", "gitlab-mcp"],
    ["start", "gitlab-mcp"],
  ]);
});

test("recovery quarantines a failed replacement before restoring rollback", () => {
  const commands = [];

  recoverDeployment(
    {
      productionPromoted: true,
      rollbackName: "gitlab-mcp-rollback-123",
    },
    {
      runDocker(args) {
        commands.push(args);
        return "";
      },
      now: () => 456,
      errorLog() {
        assert.fail("rollback should succeed");
      },
    },
  );

  assert.deepEqual(commands, [
    ["container", "inspect", "gitlab-mcp"],
    ["stop", "--time", "2", "gitlab-mcp"],
    ["rename", "gitlab-mcp", "gitlab-mcp-failed-456"],
    ["container", "inspect", "gitlab-mcp-rollback-123"],
    ["rename", "gitlab-mcp-rollback-123", "gitlab-mcp"],
    ["start", "gitlab-mcp"],
  ]);
});

test("recovery before promotion never renames production", () => {
  const commands = [];

  recoverDeployment(
    {
      productionPromoted: false,
      rollbackName: "gitlab-mcp-rollback-unused",
    },
    {
      inspectContainer() {
        return { State: { Running: false } };
      },
      runDocker(args) {
        commands.push(args);
        return "";
      },
    },
  );

  assert.deepEqual(commands, [["start", "gitlab-mcp"]]);
});

test("candidate validation failure leaves production unpromoted and cleans temporary state", async () => {
  const recovery = [];
  const removed = [];
  const dockerCommands = [];
  let promoted = false;

  await assert.rejects(
    deployCommit(currentCommit, "test-token", {
      inspectContainer() {
        return productionContainer();
      },
      readContainerEnvironment: envFrom,
      getContainerPort() {
        return { hostIp: "127.0.0.1", hostPort: "3000" };
      },
      pruneState() {
        return {};
      },
      makeTempDirectory() {
        return "/tmp/deployment";
      },
      prepareReleaseCheckout() {
        return "/srv/gitlab-mcp/releases/current";
      },
      buildRuntimeEnvironment() {
        return { MCP_BUILD_ID: currentCommit };
      },
      writeEnvironmentFile() {
        return "/tmp/deployment/runtime.env";
      },
      runDocker(args) {
        dockerCommands.push(args);
        return "";
      },
      createCandidateDeployment() {
        throw new Error("candidate validation failed");
      },
      promoteCandidateDeployment() {
        promoted = true;
      },
      recover(state) {
        recovery.push(state);
      },
      removeTempDirectory(directory) {
        removed.push(directory);
      },
      now: () => 123,
    }),
    /candidate validation failed/u,
  );

  assert.equal(promoted, false);
  assert.deepEqual(dockerCommands.at(-1), [
    "rm",
    "-f",
    `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
  ]);
  assert.deepEqual(recovery, [
    {
      productionPromoted: false,
      rollbackName: "gitlab-mcp-rollback-123",
    },
  ]);
  assert.deepEqual(removed, ["/tmp/deployment"]);
});

test("candidate failure removes temporary files containing deployment tokens", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-deploy-test-"),
  );
  const tempDirectory = path.join(root, "deployment");
  fs.mkdirSync(tempDirectory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const createdFiles = [];
  const dockerCommands = [];
  function writeEnvironmentFile(directory, name, environment) {
    const file = path.join(directory, name);
    const contents =
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n";
    fs.writeFileSync(file, contents, { mode: 0o600 });
    createdFiles.push({ file, name, contents });
    return file;
  }

  await assert.rejects(
    deployCommit(currentCommit, "test-token", {
      inspectContainer() {
        return productionContainer();
      },
      readContainerEnvironment: envFrom,
      getContainerPort() {
        return { hostIp: "127.0.0.1", hostPort: "3000" };
      },
      pruneState() {
        return {};
      },
      makeTempDirectory() {
        return tempDirectory;
      },
      prepareReleaseCheckout() {
        return "/srv/gitlab-mcp/releases/current";
      },
      buildRuntimeEnvironment() {
        return { MCP_BUILD_ID: currentCommit };
      },
      writeEnvironmentFile,
      runDocker(args) {
        dockerCommands.push(args);
        return "";
      },
      createCandidateDeployment(args) {
        return createCandidate(args, {
          runDocker(command) {
            if (
              command.some((arg) =>
                String(arg).includes("check:mcp-surface-parity"),
              )
            ) {
              return JSON.stringify({ status: "mismatch" });
            }
            return "";
          },
          waitForReady() {},
          inspectContainer() {
            return {
              NetworkSettings: {
                Ports: { "3000/tcp": [{ HostPort: "49152" }] },
              },
            };
          },
          writeEnvironmentFile,
        });
      },
      promoteCandidateDeployment() {
        assert.fail("candidate failure must prevent promotion");
      },
      recover() {},
      now: () => 123,
    }),
    /Candidate MCP surface did not match repository source/u,
  );

  const parityFile = createdFiles.find(({ name }) => name === "parity.env");
  assert.ok(
    parityFile,
    "candidate validation must create the parity token file",
  );
  assert.match(parityFile.contents, /MCP_SURFACE_PARITY_TOKEN=test-token/u);
  assert.equal(fs.existsSync(tempDirectory), false);
  assert.ok(createdFiles.every(({ file }) => !fs.existsSync(file)));
  assert.deepEqual(dockerCommands.at(-1), [
    "rm",
    "-f",
    `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
  ]);
});

test("failure after production rename triggers rollback recovery and cleanup", async () => {
  const recovery = [];
  const removed = [];
  const dockerCommands = [];
  const promotionCommands = [];

  await assert.rejects(
    deployCommit(currentCommit, "test-token", {
      inspectContainer() {
        return productionContainer();
      },
      readContainerEnvironment: envFrom,
      getContainerPort() {
        return { hostIp: "127.0.0.1", hostPort: "3000" };
      },
      pruneState() {
        return {};
      },
      makeTempDirectory() {
        return "/tmp/deployment";
      },
      prepareReleaseCheckout() {
        return "/srv/gitlab-mcp/releases/current";
      },
      buildRuntimeEnvironment() {
        return { MCP_BUILD_ID: currentCommit };
      },
      writeEnvironmentFile() {
        return "/tmp/deployment/runtime.env";
      },
      runDocker(args) {
        dockerCommands.push(args);
        return "";
      },
      createCandidateDeployment() {
        return 175;
      },
      promoteCandidateDeployment(args) {
        return promoteCandidate(args, {
          runCommand(command, commandArgs) {
            promotionCommands.push([command, ...commandArgs]);
            return "";
          },
          runDocker(command) {
            promotionCommands.push(["docker", ...command]);
            if (
              command[0] === "run" &&
              command.includes("--name") &&
              command.includes("gitlab-mcp")
            ) {
              throw new Error("replacement start failed");
            }
            return "";
          },
          getContainerPort() {
            return { hostIp: "127.0.0.1", hostPort: "3000" };
          },
        });
      },
      recover(state) {
        recovery.push(state);
      },
      removeTempDirectory(directory) {
        removed.push(directory);
      },
      now: () => 123,
    }),
    /replacement start failed/u,
  );

  const renameProduction = promotionCommands.findIndex(
    (command) =>
      command[0] === "docker" &&
      command[1] === "rename" &&
      command[2] === "gitlab-mcp" &&
      command[3] === "gitlab-mcp-rollback-123",
  );
  const failedReplacementStart = promotionCommands.findIndex(
    (command) =>
      command[0] === "docker" &&
      command[1] === "run" &&
      command.includes("gitlab-mcp"),
  );
  assert.ok(renameProduction >= 0);
  assert.ok(failedReplacementStart > renameProduction);

  assert.deepEqual(dockerCommands.at(-1), [
    "rm",
    "-f",
    `gitlab-mcp-candidate-${currentCommit.slice(0, 12)}`,
  ]);
  assert.deepEqual(recovery, [
    {
      productionPromoted: true,
      rollbackName: "gitlab-mcp-rollback-123",
    },
  ]);
  assert.deepEqual(removed, ["/tmp/deployment"]);
});

test("already-current deployment validates without candidate mutation", async () => {
  const validated = [];
  const removed = [];
  let dockerCalls = 0;
  let candidateCalls = 0;

  await deployCommit(currentCommit, "test-token", {
    inspectContainer() {
      return productionContainer(currentCommit);
    },
    readContainerEnvironment: envFrom,
    getContainerPort() {
      return { hostIp: "127.0.0.1", hostPort: "3000" };
    },
    pruneState() {
      return {};
    },
    makeTempDirectory() {
      return "/tmp/deployment";
    },
    prepareReleaseCheckout() {
      return "/srv/gitlab-mcp/releases/current";
    },
    validateCurrent(args) {
      validated.push(args);
    },
    runDocker() {
      dockerCalls += 1;
      return "";
    },
    createCandidateDeployment() {
      candidateCalls += 1;
      return 175;
    },
    removeTempDirectory(directory) {
      removed.push(directory);
    },
    now: () => 123,
  });

  assert.equal(dockerCalls, 0);
  assert.equal(candidateCalls, 0);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].commit, currentCommit);
  assert.equal(validated[0].parityToken, "test-token");
  assert.equal(validated[0].tempDirectory, "/tmp/deployment");
  assert.deepEqual(removed, ["/tmp/deployment"]);
});
