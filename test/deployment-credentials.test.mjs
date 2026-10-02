import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProductionRuntimeEnvironment,
  readDeploymentValidationTokenFile,
} from "../scripts/deploy-production.mjs";

const commit = "d".repeat(40);

function validationTokenPath(
  releaseRoot,
  suffix = process.pid,
  random = "ABC123",
) {
  return path.join(releaseRoot, `.deploy-validation-${suffix}.${random}.token`);
}

test("replacement production runtime strips shared GitLab credentials", () => {
  const runtime = buildProductionRuntimeEnvironment(
    {
      NODE_ENV: "production",
      GITLAB_URL: "https://gitlab.example.com",
      GITLAB_TOKEN: "legacy-shared-token",
      GITLAB_PRIVATE_TOKEN: "legacy-private-token",
      MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
      MCP_ALLOWED_HOSTS: "mcp.example.com",
      MCP_BUILD_ID: "a".repeat(40),
      MCP_DEPLOY_VALIDATION_TOKEN: "must-not-propagate",
      MCP_SURFACE_PARITY_TOKEN: "must-not-propagate",
      MCP_RUNTIME_TOKEN: "must-not-propagate",
      MCP_EXPECTED_BUILD_ID: "must-not-propagate",
      MCP_EXPECTED_TOOL_COUNT: "175",
    },
    commit,
  );

  assert.equal(runtime.GITLAB_TOKEN, undefined);
  assert.equal(runtime.GITLAB_PRIVATE_TOKEN, undefined);
  assert.equal(runtime.MCP_DEPLOY_VALIDATION_TOKEN, undefined);
  assert.equal(runtime.MCP_SURFACE_PARITY_TOKEN, undefined);
  assert.equal(runtime.MCP_RUNTIME_TOKEN, undefined);
  assert.equal(runtime.MCP_EXPECTED_BUILD_ID, undefined);
  assert.equal(runtime.MCP_EXPECTED_TOOL_COUNT, undefined);
  assert.equal(runtime.GITLAB_URL, "https://gitlab.example.com");
  assert.equal(runtime.MCP_PUBLIC_URL, "https://mcp.example.com/mcp");
  assert.equal(runtime.MCP_BUILD_ID, commit);
});

test("deployment validation token is consumed from a private transfer file", () => {
  const releaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-release-"),
  );
  const tokenFile = validationTokenPath(releaseRoot);
  try {
    fs.writeFileSync(tokenFile, "deployment-validation-token", { mode: 0o600 });
    assert.equal(
      readDeploymentValidationTokenFile(tokenFile, releaseRoot),
      "deployment-validation-token",
    );
    assert.equal(fs.existsSync(tokenFile), false);
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("deployment validation token cleanup survives descriptor close errors", () => {
  const releaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-release-"),
  );
  const tokenFile = validationTokenPath(
    releaseRoot,
    process.pid + 8,
    "CLOSEFAIL",
  );
  const originalCloseSync = fs.closeSync;
  try {
    fs.writeFileSync(tokenFile, "deployment-validation-token", { mode: 0o600 });
    fs.closeSync = (descriptor) => {
      originalCloseSync(descriptor);
      throw new Error("synthetic close failure");
    };
    assert.throws(
      () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
      /synthetic close failure/u,
    );
    assert.equal(fs.existsSync(tokenFile), false);
  } finally {
    fs.closeSync = originalCloseSync;
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("deployment validation token size is bounded before consumption", () => {
  const releaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-release-"),
  );
  const tokenFile = validationTokenPath(
    releaseRoot,
    process.pid + 3,
    "OVERSIZE",
  );
  try {
    fs.writeFileSync(tokenFile, "x".repeat(8193), { mode: 0o600 });
    assert.throws(
      () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
      /Deployment validation token file is empty or malformed\./u,
    );
    assert.equal(fs.existsSync(tokenFile), false);
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("deployment validation token reader rejects malformed content", () => {
  const releaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-release-"),
  );
  try {
    for (const [offset, random, content] of [
      [4, "EMPTY", ""],
      [5, "NEWLINE", "token-with-newline\n"],
    ]) {
      const tokenFile = validationTokenPath(
        releaseRoot,
        process.pid + offset,
        random,
      );
      fs.writeFileSync(tokenFile, content, { mode: 0o600 });
      assert.throws(
        () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
        /Deployment validation token file is empty or malformed\./u,
      );
      assert.equal(fs.existsSync(tokenFile), false);
    }
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test(
  "deployment validation token reader rejects broad file permissions",
  { skip: process.platform === "win32" },
  () => {
    const releaseRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gitlab-mcp-release-"),
    );
    const tokenFile = validationTokenPath(
      releaseRoot,
      process.pid + 6,
      "PERMS",
    );
    try {
      fs.writeFileSync(tokenFile, "deployment-validation-token", {
        mode: 0o600,
      });
      fs.chmodSync(tokenFile, 0o644);
      assert.throws(
        () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
        /Deployment validation token file permissions are too broad\./u,
      );
      assert.equal(fs.existsSync(tokenFile), false);
    } finally {
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  },
);

test("deployment validation token path cannot escape the release root", () => {
  const releaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gitlab-mcp-release-"),
  );
  const outsideFile = path.join(
    os.tmpdir(),
    `.deploy-validation-${process.pid + 1}.ABC123.token`,
  );
  try {
    fs.writeFileSync(outsideFile, "must-remain", { mode: 0o600 });
    assert.throws(
      () => readDeploymentValidationTokenFile(outsideFile, releaseRoot),
      /Deployment validation token file path is invalid\./u,
    );
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "must-remain");
  } finally {
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("deployment source no longer reads parity credentials from production environment", () => {
  const source = fs.readFileSync(
    new URL("../scripts/deploy-production.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /productionEnvironment\.GITLAB_(?:TOKEN|PRIVATE_TOKEN)/u,
  );
});

test(
  "deployment validation token reader opens non-blocking before type validation",
  { skip: process.platform === "win32" },
  () => {
    const releaseRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gitlab-mcp-release-"),
    );
    const tokenFile = validationTokenPath(
      releaseRoot,
      process.pid + 7,
      "NONBLOCK",
    );
    const originalOpenSync = fs.openSync;
    let observedFlags = 0;
    try {
      fs.openSync = (_file, flags) => {
        observedFlags = flags;
        const error = new Error("synthetic open failure");
        error.code = "EACCES";
        throw error;
      };
      assert.throws(
        () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
        /synthetic open failure/u,
      );
      assert.notEqual(observedFlags & fs.constants.O_NONBLOCK, 0);
    } finally {
      fs.openSync = originalOpenSync;
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  },
);

test(
  "deployment validation token reader rejects symlinks",
  { skip: process.platform === "win32" },
  () => {
    const releaseRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gitlab-mcp-release-"),
    );
    const targetFile = path.join(releaseRoot, "target-token");
    const tokenFile = validationTokenPath(
      releaseRoot,
      process.pid + 2,
      "SYMLNK",
    );
    try {
      fs.writeFileSync(targetFile, "target-secret", { mode: 0o600 });
      fs.symlinkSync(targetFile, tokenFile);
      assert.throws(
        () => readDeploymentValidationTokenFile(tokenFile, releaseRoot),
        /Deployment validation token path is not a file\./u,
      );
      assert.equal(fs.readFileSync(targetFile, "utf8"), "target-secret");
      assert.equal(fs.existsSync(tokenFile), false);
    } finally {
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  },
);
