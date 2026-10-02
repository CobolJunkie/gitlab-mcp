#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ROLLBACK_PATTERN = /^gitlab-mcp-rollback-(\d+)$/;
const CANDIDATE_PATTERN = /^gitlab-mcp-candidate-[a-f0-9]{12}$/;
const FAILED_PATTERN = /^gitlab-mcp-failed-(\d+)$/;
const RELEASE_PATTERN = /^([a-f0-9]{40})(?:-deploy)?$/;
const IMAGE_PATTERN = /^gitlab-mcp:sha-([a-f0-9]{40})$/;

export function isCommitSha(value) {
  return COMMIT_SHA_PATTERN.test(value || "");
}

export function isSafeReleaseRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  if (path.sep === "/" && /[^A-Za-z0-9_./-]/u.test(value)) return false;
  if (value.split(path.sep).includes("..")) return false;
  const normalized = path.resolve(value);
  return normalized !== path.parse(normalized).root;
}

export function buildProductionRuntimeEnvironment(environment, commit) {
  const runtimeEnvironment = { ...environment, MCP_BUILD_ID: commit };
  for (const key of [
    "GITLAB_TOKEN",
    "GITLAB_PRIVATE_TOKEN",
    "MCP_DEPLOY_VALIDATION_TOKEN",
    "MCP_SURFACE_PARITY_TOKEN",
    "MCP_RUNTIME_TOKEN",
    "MCP_EXPECTED_BUILD_ID",
    "MCP_EXPECTED_TOOL_COUNT",
  ]) {
    delete runtimeEnvironment[key];
  }
  return runtimeEnvironment;
}

export function readDeploymentValidationTokenFile(file, releaseRoot) {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const resolvedFile = path.resolve(file || "");
  const fileName = path.basename(resolvedFile);
  if (
    !path.isAbsolute(file || "") ||
    path.dirname(resolvedFile) !== resolvedReleaseRoot ||
    !/^\.deploy-validation-\d+\.[A-Za-z0-9]+\.token$/u.test(fileName)
  ) {
    throw new Error("Deployment validation token file path is invalid.");
  }

  let descriptor;
  try {
    const openFlags =
      fs.constants.O_RDONLY |
      (process.platform === "win32"
        ? 0
        : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      // The path is confined to the validated release root and deployment-owned
      // filename grammar above. O_NOFOLLOW closes the lstat/read pathname race
      // on the Linux production host.
      // nosemgrep: eslint.detect-non-literal-fs-filename
      descriptor = fs.openSync(resolvedFile, openFlags);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ELOOP"
      ) {
        throw new Error("Deployment validation token path is not a file.");
      }
      throw error;
    }

    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error("Deployment validation token path is not a file.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(
        "Deployment validation token file permissions are too broad.",
      );
    }
    if (metadata.size < 1 || metadata.size > 8192) {
      throw new Error(
        "Deployment validation token file is empty or malformed.",
      );
    }
    // Read through the already-opened, fstat-validated and size-bounded descriptor.
    // nosemgrep: eslint.detect-non-literal-fs-filename
    const token = fs.readFileSync(descriptor, "utf8");
    if (!token || token.length > 8192 || /[\r\n\0]/u.test(token)) {
      throw new Error(
        "Deployment validation token file is empty or malformed.",
      );
    }
    return token;
  } finally {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      fs.rmSync(resolvedFile, { force: true });
    }
  }
}

export function validateDeploymentPublicUrl(value) {
  let publicResource;
  try {
    publicResource = new URL(value || "");
  } catch {
    throw new Error("Deployment public URL must be HTTPS and end in /mcp.");
  }
  const resourceWithoutQueryOrFragment = new URL(publicResource);
  resourceWithoutQueryOrFragment.search = "";
  resourceWithoutQueryOrFragment.hash = "";
  if (
    publicResource.protocol !== "https:" ||
    publicResource.username ||
    publicResource.password ||
    publicResource.href !== resourceWithoutQueryOrFragment.href ||
    !publicResource.pathname.endsWith("/mcp")
  ) {
    throw new Error("Deployment public URL must be HTTPS and end in /mcp.");
  }
  return publicResource;
}

export function selectRollbackToKeep(containerNames) {
  return (
    containerNames
      .map((name) => {
        const match = ROLLBACK_PATTERN.exec(name);
        return match ? { name, timestamp: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          right.timestamp - left.timestamp ||
          left.name.localeCompare(right.name),
      )[0]?.name ?? null
  );
}

export function selectPrunableContainerNames(
  containerNames,
  keepRollbackName = null,
  pruneRollbackContainers = true,
) {
  return containerNames
    .filter((name) => {
      if (name === keepRollbackName) return false;
      return (
        (pruneRollbackContainers && ROLLBACK_PATTERN.test(name)) ||
        CANDIDATE_PATTERN.test(name) ||
        FAILED_PATTERN.test(name)
      );
    })
    .sort();
}

export function selectPrunableReleaseNames(releaseNames, keepCommits) {
  const keep = new Set([...keepCommits].filter(isCommitSha));
  return releaseNames
    .filter((name) => {
      const match = RELEASE_PATTERN.exec(name);
      return Boolean(match && !keep.has(match[1]));
    })
    .sort();
}

export function selectPrunableImageTags(imageTags, keepCommits) {
  const keep = new Set([...keepCommits].filter(isCommitSha));
  return imageTags
    .filter((tag) => {
      const match = IMAGE_PATTERN.exec(tag);
      return Boolean(match && !keep.has(match[1]));
    })
    .sort();
}

const repository =
  "https://gitlab.villainmindset.org/CobolJunkie/gitlab-codex-plugin.git";
const productionName = "gitlab-mcp";
let normalizedPublicUrl;
let hostName;
let releases;

function configureDeploymentArguments() {
  const commit = process.argv[2];
  const releaseRoot = process.argv[3];
  const encodedPublicUrl = process.argv[4] === "--public-url-base64url";
  const publicUrl = encodedPublicUrl
    ? Buffer.from(process.argv[5] || "", "base64url").toString("utf8")
    : process.argv[4];
  const optionIndex = encodedPublicUrl ? 6 : 5;

  assertCommit(commit);
  if (!isSafeReleaseRoot(releaseRoot)) {
    throw new Error(
      "Deployment release root must be an absolute safe non-root path.",
    );
  }

  const publicResource = validateDeploymentPublicUrl(publicUrl);

  normalizedPublicUrl = publicResource.toString();
  hostName = publicResource.hostname;
  releases = path.resolve(releaseRoot);
  if (
    process.argv[optionIndex] !== "--validation-token-file" ||
    !process.argv[optionIndex + 1] ||
    process.argv[optionIndex + 2] !== undefined
  ) {
    throw new Error(
      "Deployment requires exactly one --validation-token-file argument.",
    );
  }
  const validationToken = readDeploymentValidationTokenFile(
    process.argv[optionIndex + 1],
    releases,
  );
  return { commit, validationToken };
}
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function docker(args, options) {
  return run("docker", args, options);
}

function gitAt(directory, args) {
  return run("git", [
    "-c",
    `safe.directory=${directory}`,
    "-C",
    directory,
    ...args,
  ]);
}

function inspect(name) {
  return JSON.parse(docker(["inspect", name]))[0];
}

function containerEnv(container) {
  return Object.fromEntries(
    (container.Config.Env || []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function outputLines(output) {
  return output ? output.split("\n").filter(Boolean) : [];
}

function rollbackCommit(name) {
  if (!name) return null;
  try {
    const commit = containerEnv(inspect(name)).MCP_BUILD_ID;
    return isCommitSha(commit) ? commit : null;
  } catch {
    return null;
  }
}

function pruneReleaseCheckouts(keepCommits, enabled) {
  const pruned = [];
  const retained = [];
  if (!enabled) return { pruned, retained };

  // The release root is protected deployment configuration validated above.
  // nosemgrep: eslint.detect-non-literal-fs-filename
  if (!fs.existsSync(releases)) return { pruned, retained };

  // Reading is confined to that validated release root.
  // nosemgrep: eslint.detect-non-literal-fs-filename
  const releaseNames = fs
    .readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of selectPrunableReleaseNames(releaseNames, keepCommits)) {
    const releaseToPrune = path.resolve(releases, name);
    if (path.dirname(releaseToPrune) !== releases) {
      throw new Error("Refusing to prune a release outside the release root.");
    }
    try {
      // Names come only from the exact SHA/-deploy retention selector above.
      // nosemgrep: eslint.detect-non-literal-fs-filename
      fs.rmSync(releaseToPrune, { recursive: true, force: true });
      pruned.push(name);
    } catch {
      retained.push(name);
      console.warn(
        `Retained deployment release checkout could not be removed: ${name}`,
      );
    }
  }
  return { pruned, retained };
}

function pruneDeploymentImages(keepCommits, enabled) {
  const pruned = [];
  const retained = [];
  if (!enabled) return { pruned, retained };

  const imageTags = outputLines(
    docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]),
  );
  for (const tag of selectPrunableImageTags(imageTags, keepCommits)) {
    try {
      docker(["image", "rm", tag]);
      pruned.push(tag);
    } catch {
      retained.push(tag);
      console.warn(`Retained deployment image could not be removed: ${tag}`);
    }
  }
  return { pruned, retained };
}

function pruneDeploymentState({ currentCommit, keepRollbackName } = {}) {
  const containerNames = outputLines(
    docker(["ps", "-a", "--format", "{{.Names}}"]),
  );
  const retainedRollback =
    keepRollbackName === undefined
      ? selectRollbackToKeep(containerNames)
      : keepRollbackName;
  const rollbackBuildId = rollbackCommit(retainedRollback);
  const currentBuildKnown = isCommitSha(currentCommit);
  const rollbackBuildKnown = !retainedRollback || Boolean(rollbackBuildId);
  const canPruneVersionedState = currentBuildKnown && rollbackBuildKnown;
  const keepCommits = new Set();
  if (currentBuildKnown) keepCommits.add(currentCommit);
  if (rollbackBuildId) keepCommits.add(rollbackBuildId);

  const prunedContainers = selectPrunableContainerNames(
    containerNames,
    retainedRollback,
    rollbackBuildKnown,
  );
  for (const name of prunedContainers) docker(["rm", "-f", name]);

  const releasesResult = pruneReleaseCheckouts(
    keepCommits,
    canPruneVersionedState,
  );
  const imagesResult = pruneDeploymentImages(
    keepCommits,
    canPruneVersionedState,
  );

  return {
    rollbackContainer: retainedRollback,
    rollbackBuildId,
    versionedStatePruningEnabled: canPruneVersionedState,
    retainedCommits: [...keepCommits].sort((left, right) =>
      left.localeCompare(right),
    ),
    prunedContainers,
    prunedReleases: releasesResult.pruned,
    retainedReleases: releasesResult.retained,
    prunedImages: imagesResult.pruned,
    retainedImages: imagesResult.retained,
  };
}

function envText(environment) {
  return Object.entries(environment)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replaceAll("\n", "")}`)
    .join("\n");
}

function writePrivateEnv(directory, name, environment) {
  // Callers pass only fixed internal names under the mkdtemp-created directory.
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${envText(environment)}\n`, { mode: 0o600 }); // nosemgrep: eslint.detect-non-literal-fs-filename
  return file;
}

function waitForContainer(name, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = JSON.parse(
        docker([
          "exec",
          name,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/ready').then(async r=>{const b=await r.json();console.log(JSON.stringify({ok:r.ok,status:b.status}));process.exit(r.ok&&b.status==='ready'?0:1)}).catch(()=>process.exit(1))",
        ]),
      );
      if (ready.ok) return;
    } catch {
      // Continue polling while the container starts.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  throw new Error(`Container ${name} did not become ready in time.`);
}

function containerPort(container) {
  const bindings = container.NetworkSettings.Ports["3000/tcp"];
  if (!bindings?.length)
    throw new Error("Production has no published MCP port.");
  return {
    hostIp: bindings[0].HostIp || "0.0.0.0",
    hostPort: bindings[0].HostPort,
  };
}

function assertCommit(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Expected an exact 40-character commit SHA.");
  }
}

function prepareRelease(commit) {
  const releasePath = path.join(releases, commit);
  let release = releasePath;
  // The release root is protected CI configuration, validated before use.
  fs.mkdirSync(releases, { recursive: true, mode: 0o755 }); // nosemgrep: eslint.detect-non-literal-fs-filename
  fs.accessSync(
    releases,
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
  // SHA-derived paths use only the previously validated commit identifier.
  // nosemgrep: eslint.detect-non-literal-fs-filename
  if (fs.existsSync(releasePath)) {
    try {
      fs.accessSync(
        releasePath,
        fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
      );
    } catch {
      release = path.join(releases, `${commit}-deploy`);
    }
  }
  // nosemgrep: eslint.detect-non-literal-fs-filename
  if (fs.existsSync(release)) {
    fs.accessSync(
      release,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    );
  }
  // nosemgrep: eslint.detect-non-literal-fs-filename
  if (!fs.existsSync(path.join(release, ".git"))) {
    fs.mkdirSync(release, { recursive: true, mode: 0o755 }); // nosemgrep: eslint.detect-non-literal-fs-filename
    run("git", ["clone", "--no-checkout", repository, release]);
  }
  gitAt(release, ["remote", "set-url", "origin", repository]);
  gitAt(release, ["fetch", "--no-tags", "origin", commit]);
  gitAt(release, ["checkout", "--detach", "--force", "FETCH_HEAD"]);
  const head = gitAt(release, ["rev-parse", "HEAD"]);
  if (head !== commit) {
    throw new Error("Fetched source did not match requested SHA.");
  }
  const dirty = gitAt(release, ["status", "--porcelain"]);
  if (dirty) throw new Error("Release checkout is not clean after checkout.");
  gitAt(release, ["fetch", "--no-tags", "origin", "main"]);
  gitAt(release, ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
  return release;
}

function parseParity(output) {
  return JSON.parse(output.slice(output.indexOf("{")));
}

function assertMatchingParity(parity, scope) {
  if (parity.status !== "match") {
    throw new Error(`${scope} MCP surface did not match repository source.`);
  }
  const toolCount = parity.canonical?.count;
  if (!Number.isInteger(toolCount) || toolCount < 1) {
    throw new Error("Parity report omitted canonical tool count.");
  }
  return toolCount;
}

export function validateCurrentDeployment(
  { commit, release, normalizedPublicUrl, parityToken, tempDirectory },
  {
    runDocker = docker,
    writeEnvironmentFile = writePrivateEnv,
    log = console.log,
  } = {},
) {
  const parityEnvironment = writeEnvironmentFile(
    tempDirectory,
    "current-parity.env",
    { MCP_SURFACE_PARITY_TOKEN: parityToken },
  );
  runDocker([
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${release}:/src`,
    "-w",
    "/src",
    "node:22-alpine",
    "sh",
    "-ec",
    'npm ci --no-audit --no-fund >/dev/null && npm run check:mcp-deployment -- "$1"',
    "deployment-check",
    normalizedPublicUrl,
  ]);
  const parity = parseParity(
    runDocker([
      "run",
      "--rm",
      "--network",
      "host",
      "--env-file",
      parityEnvironment,
      "-v",
      `${release}:/src`,
      "-w",
      "/src",
      "node:22-alpine",
      "sh",
      "-ec",
      'npm ci --no-audit --no-fund >/dev/null && npm run check:mcp-surface-parity -- "$1"',
      "surface-parity-check",
      normalizedPublicUrl,
    ]),
  );
  const toolCount = assertMatchingParity(parity, "Current production");
  const runtimeEnvironment = writeEnvironmentFile(
    tempDirectory,
    "current-runtime.env",
    {
      MCP_RUNTIME_TOKEN: parityToken,
      MCP_EXPECTED_BUILD_ID: commit,
      MCP_EXPECTED_TOOL_COUNT: String(toolCount),
    },
  );
  runDocker([
    "run",
    "--rm",
    "--network",
    "host",
    "--env-file",
    runtimeEnvironment,
    "-v",
    `${release}:/src`,
    "-w",
    "/src",
    "node:22-alpine",
    "node",
    "scripts/check-mcp-runtime.mjs",
    normalizedPublicUrl,
  ]);
  log(
    JSON.stringify({
      status: "already_current",
      buildId: commit,
      toolCount,
      runtimeFingerprint: parity.remote?.fingerprint,
    }),
  );
}

export function createCandidate(
  {
    commit,
    release,
    image,
    candidateName,
    hostName,
    hostIp,
    runtimeEnvFile,
    normalizedPublicUrl,
    parityToken,
    tempDirectory,
  },
  {
    runDocker = docker,
    waitForReady = waitForContainer,
    inspectContainer = inspect,
    writeEnvironmentFile = writePrivateEnv,
  } = {},
) {
  try {
    runDocker(["rm", "-f", candidateName]);
  } catch {
    // A stale candidate with this exact SHA can be replaced safely.
  }
  runDocker([
    "run",
    "-d",
    "--name",
    candidateName,
    "--restart",
    "no",
    "--env-file",
    runtimeEnvFile,
    "-p",
    `${hostIp}::3000`,
    image,
  ]);
  waitForReady(candidateName);
  const candidate = inspectContainer(candidateName);
  const candidateHostPort =
    candidate.NetworkSettings.Ports["3000/tcp"][0].HostPort;
  const candidateUrl = `http://${hostName}:${candidateHostPort}/mcp`;
  runDocker([
    "run",
    "--rm",
    "--network",
    "host",
    "--add-host",
    `${hostName}:${hostIp}`,
    "-v",
    `${release}:/src`,
    "-w",
    "/src",
    "node:22-alpine",
    "node",
    "scripts/check-mcp-candidate.mjs",
    candidateUrl,
    normalizedPublicUrl,
  ]);
  const parityEnvironment = writeEnvironmentFile(tempDirectory, "parity.env", {
    MCP_SURFACE_PARITY_TOKEN: parityToken,
    MCP_RUNTIME_TOKEN: parityToken,
    MCP_EXPECTED_BUILD_ID: commit,
  });
  const parity = parseParity(
    runDocker([
      "run",
      "--rm",
      "--network",
      "host",
      "--add-host",
      `${hostName}:${hostIp}`,
      "--env-file",
      parityEnvironment,
      "-v",
      `${release}:/src`,
      "-w",
      "/src",
      "node:22-alpine",
      "sh",
      "-ec",
      'npm ci --no-audit --no-fund >/dev/null && npm run check:mcp-surface-parity -- "$1" --allow-insecure-http',
      "candidate-surface-parity-check",
      candidateUrl,
    ]),
  );
  const toolCount = assertMatchingParity(parity, "Candidate");
  const candidateValidationEnvironment = writeEnvironmentFile(
    tempDirectory,
    "candidate-validation.env",
    {
      MCP_RUNTIME_TOKEN: parityToken,
      MCP_EXPECTED_BUILD_ID: commit,
      MCP_EXPECTED_TOOL_COUNT: String(toolCount),
    },
  );
  runDocker([
    "run",
    "--rm",
    "--network",
    "host",
    "--add-host",
    `${hostName}:${hostIp}`,
    "--env-file",
    candidateValidationEnvironment,
    "-v",
    `${release}:/src`,
    "-w",
    "/src",
    "node:22-alpine",
    "node",
    "scripts/check-mcp-runtime.mjs",
    candidateUrl,
  ]);
  return toolCount;
}

export function promoteCandidate(
  {
    state,
    commit,
    priorCommit,
    production,
    candidateName,
    image,
    rollbackName,
    runtimeEnvFile,
    release,
    parityToken,
    toolCount,
    normalizedPublicUrl,
    tempDirectory,
  },
  {
    runCommand = run,
    runDocker = docker,
    waitForReady = waitForContainer,
    inspectContainer = inspect,
    readContainerEnvironment = containerEnv,
    getContainerPort = containerPort,
    writeEnvironmentFile = writePrivateEnv,
    pruneState = pruneDeploymentState,
    log = console.log,
  } = {},
) {
  runCommand("docker", ["stop", "--time", "2", candidateName]);
  runDocker(["stop", "--time", "2", productionName]);
  runDocker(["rename", productionName, rollbackName]);
  state.productionPromoted = true;
  const originalBindings = getContainerPort(production);
  runDocker([
    "run",
    "-d",
    "--name",
    productionName,
    "--restart",
    production.HostConfig.RestartPolicy.Name || "unless-stopped",
    "--env-file",
    runtimeEnvFile,
    "-p",
    `${originalBindings.hostIp}:${originalBindings.hostPort}:3000`,
    image,
  ]);
  waitForReady(productionName);
  const validationEnvironment = writeEnvironmentFile(
    tempDirectory,
    "validation.env",
    {
      MCP_SURFACE_PARITY_TOKEN: parityToken,
      MCP_RUNTIME_TOKEN: parityToken,
      MCP_EXPECTED_BUILD_ID: commit,
      MCP_EXPECTED_TOOL_COUNT: String(toolCount),
    },
  );
  runDocker([
    "run",
    "--rm",
    "--network",
    "host",
    "--env-file",
    validationEnvironment,
    "-v",
    `${release}:/src`,
    "-w",
    "/src",
    "node:22-alpine",
    "sh",
    "-ec",
    'npm ci --no-audit --no-fund >/dev/null && npm run check:mcp-deployment -- "$1" && npm run check:mcp-surface-parity -- "$1" && node scripts/check-mcp-runtime.mjs "$1"',
    "post-promotion-check",
    normalizedPublicUrl,
  ]);
  const finalRuntime = inspectContainer(productionName);
  if (readContainerEnvironment(finalRuntime).MCP_BUILD_ID !== commit) {
    throw new Error(
      "Promoted container environment reports an unexpected build ID.",
    );
  }
  state.deploymentValidated = true;
  const retention = pruneState({
    currentCommit: commit,
    keepRollbackName: rollbackName,
  });
  log(
    JSON.stringify({
      status: "deployed",
      buildId: commit,
      priorBuildId: priorCommit,
      toolCount,
      imageId: finalRuntime.Image,
      rollbackContainer: rollbackName,
      retention,
    }),
  );
}

export function recoverDeployment(
  { productionPromoted, rollbackName },
  {
    inspectContainer = inspect,
    runDocker = docker,
    now = Date.now,
    errorLog = console.error,
  } = {},
) {
  if (!productionPromoted) {
    try {
      const current = inspectContainer(productionName);
      if (!current.State.Running) runDocker(["start", productionName]);
    } catch {
      // Preserve the original deployment state if inspection is unavailable.
    }
    return;
  }
  try {
    const failedName = `gitlab-mcp-failed-${now()}`;
    try {
      runDocker(["container", "inspect", productionName]);
      runDocker(["stop", "--time", "2", productionName]);
      runDocker(["rename", productionName, failedName]);
    } catch {
      // The failed replacement may not have been created.
    }
    runDocker(["container", "inspect", rollbackName]);
    runDocker(["rename", rollbackName, productionName]);
    runDocker(["start", productionName]);
  } catch {
    errorLog(
      "Automatic rollback failed; preserve containers and restore the prior gitlab-mcp-rollback container manually.",
    );
  }
}

export async function deployCommit(
  commit,
  parityToken,
  {
    inspectContainer = inspect,
    readContainerEnvironment = containerEnv,
    getContainerPort = containerPort,
    pruneState = pruneDeploymentState,
    makeTempDirectory = () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "gitlab-mcp-deploy-")),
    prepareReleaseCheckout = prepareRelease,
    validateCurrent = validateCurrentDeployment,
    buildRuntimeEnvironment = buildProductionRuntimeEnvironment,
    writeEnvironmentFile = writePrivateEnv,
    runDocker = docker,
    createCandidateDeployment = createCandidate,
    promoteCandidateDeployment = promoteCandidate,
    recover = recoverDeployment,
    removeTempDirectory = (directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    now = Date.now,
  } = {},
) {
  const production = inspectContainer(productionName);
  const productionEnvironment = readContainerEnvironment(production);
  const priorCommit = productionEnvironment.MCP_BUILD_ID || "unknown";
  const image = `gitlab-mcp:sha-${commit}`;
  const candidateName = `gitlab-mcp-candidate-${commit.slice(0, 12)}`;
  const rollbackName = `gitlab-mcp-rollback-${now()}`;
  const { hostIp } = getContainerPort(production);
  let tempDirectory = null;
  const state = { productionPromoted: false, deploymentValidated: false };
  try {
    pruneState({ currentCommit: priorCommit });
    tempDirectory = makeTempDirectory();
    const release = prepareReleaseCheckout(commit);
    if (priorCommit === commit) {
      validateCurrent({
        commit,
        release,
        normalizedPublicUrl,
        parityToken,
        tempDirectory,
      });
      return;
    }
    const runtimeEnvironment = buildRuntimeEnvironment(
      productionEnvironment,
      commit,
    );
    const runtimeEnvFile = writeEnvironmentFile(
      tempDirectory,
      "runtime.env",
      runtimeEnvironment,
    );
    runDocker([
      "run",
      "--rm",
      "-v",
      `${release}:/src`,
      "-w",
      "/src",
      "node:22-alpine",
      "sh",
      "-ec",
      "npm ci --no-audit --no-fund && npm run build",
    ]);
    runDocker([
      "build",
      "--label",
      `org.opencontainers.image.revision=${commit}`,
      "-t",
      image,
      release,
    ]);
    const toolCount = createCandidateDeployment({
      commit,
      release,
      image,
      candidateName,
      hostName,
      hostIp,
      runtimeEnvFile,
      normalizedPublicUrl,
      parityToken,
      tempDirectory,
    });
    promoteCandidateDeployment({
      state,
      commit,
      priorCommit,
      production,
      candidateName,
      image,
      rollbackName,
      runtimeEnvFile,
      release,
      parityToken,
      toolCount,
      normalizedPublicUrl,
      tempDirectory,
    });
  } catch (error) {
    try {
      runDocker(["rm", "-f", candidateName]);
    } catch {
      // The candidate may not have been created.
    }
    if (!state.deploymentValidated) {
      recover({
        productionPromoted: state.productionPromoted,
        rollbackName,
      });
    }
    throw error;
  } finally {
    if (tempDirectory) {
      removeTempDirectory(tempDirectory);
    }
  }
}

async function main() {
  if (process.argv[2] === "--encode-public-url") {
    const publicResource = validateDeploymentPublicUrl(process.argv[3]);
    process.stdout.write(
      Buffer.from(publicResource.toString(), "utf8").toString("base64url"),
    );
    return;
  }

  const { commit, validationToken } = configureDeploymentArguments();
  await deployCommit(commit, validationToken);
}

function isDirectExecution() {
  if (process.argv[1] === "-") return true;
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
