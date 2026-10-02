import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isCommitSha,
  isSafeReleaseRoot,
  selectPrunableContainerNames,
  selectPrunableImageTags,
  selectPrunableReleaseNames,
  selectRollbackToKeep,
  validateDeploymentPublicUrl,
} from "../scripts/deploy-production.mjs";

const current = "a".repeat(40);
const rollback = "b".repeat(40);
const stale = "c".repeat(40);

test("streamed deployment entrypoint stays self-contained", () => {
  const deploySource = readFileSync(
    new URL("../scripts/deploy-production.mjs", import.meta.url),
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-",
      "not-a-commit",
      path.join(
        path.parse(path.resolve(".")).root,
        "srv",
        "gitlab-mcp-releases",
      ),
      "https://example.com/mcp",
    ],
    {
      encoding: "utf8",
      input: deploySource,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected an exact 40-character commit SHA\./);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("release root validation rejects filesystem root and traversal", () => {
  const root = path.parse(path.resolve(".")).root;
  const safeRoot = path.join(root, "srv", "gitlab-mcp-releases");
  const normalizedRootAlias = `${root}.${path.sep}`;
  const traversalRoot = `${path.join(root, "srv")}${path.sep}..${path.sep}tmp${path.sep}gitlab-mcp-releases`;

  assert.equal(isSafeReleaseRoot(safeRoot), true);
  assert.equal(isSafeReleaseRoot(root), false);
  assert.equal(isSafeReleaseRoot(normalizedRootAlias), false);
  assert.equal(isSafeReleaseRoot(traversalRoot), false);
  assert.equal(isSafeReleaseRoot(path.join("relative", "releases")), false);
});

test(
  "release root validation rejects shell-unsafe content before remote use",
  { skip: process.platform === "win32" },
  () => {
    assert.equal(isSafeReleaseRoot("/srv/gitlab-mcp-releases"), true);
    assert.equal(
      isSafeReleaseRoot("/srv/gitlab-mcp-releases\n'; echo injected; #"),
      false,
    );
    assert.equal(isSafeReleaseRoot("/srv/gitlab-mcp-'releases"), false);
  },
);

test("deployment public URL validation accepts documented ports and subpaths", () => {
  for (const value of [
    "https://mcp.example.com/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://mcp.example.com/reverse/proxy/mcp",
  ]) {
    assert.equal(validateDeploymentPublicUrl(value).toString(), value);
  }
});

test("deployment public URL encoder is safe for shell argument transport", () => {
  const publicUrl = "https://mcp.example.com/proxy/$()/quotes'/mcp";
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../scripts/deploy-production.mjs", import.meta.url),
      ),
      "--encode-public-url",
      publicUrl,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[A-Za-z0-9_-]+$/u);
  assert.equal(
    Buffer.from(result.stdout, "base64url").toString("utf8"),
    publicUrl,
  );
});

test("streamed deployment revalidates encoded public URLs before mutation", () => {
  const deploySource = readFileSync(
    new URL("../scripts/deploy-production.mjs", import.meta.url),
    "utf8",
  );
  const root = path.parse(path.resolve(".")).root;
  const releaseRoot = path.join(root, "srv", "gitlab-mcp-releases");
  const encodedInsecureUrl = Buffer.from(
    "http://mcp.example.com/mcp",
    "utf8",
  ).toString("base64url");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-",
      current,
      releaseRoot,
      "--public-url-base64url",
      encodedInsecureUrl,
    ],
    {
      encoding: "utf8",
      input: deploySource,
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Deployment public URL must be HTTPS and end in \/mcp\./,
  );
  assert.doesNotMatch(result.stderr, /docker/u);
});

test("deployment public URL validation rejects unsafe or unsupported variants", () => {
  for (const value of [
    "http://mcp.example.com/mcp",
    "https://user@mcp.example.com/mcp",
    ["https://user", ":placeholder@", "mcp.example.com/mcp"].join(""),
    "https://mcp.example.com/mcp?debug=1",
    "https://mcp.example.com/mcp?",
    "https://mcp.example.com/mcp#fragment",
    "https://mcp.example.com/mcp#",
    "https://mcp.example.com/mcp?#",
    "https://mcp.example.com/mcp/",
    "https://mcp.example.com/not-mcp",
    "not-a-url",
  ]) {
    assert.throws(
      () => validateDeploymentPublicUrl(value),
      /Deployment public URL must be HTTPS and end in \/mcp\./,
      value,
    );
  }
});

test("selectRollbackToKeep retains the newest timestamped rollback", () => {
  assert.equal(
    selectRollbackToKeep([
      "gitlab-mcp",
      "gitlab-mcp-rollback-100",
      "gitlab-mcp-rollback-300",
      "gitlab-mcp-rollback-200",
      "gitlab-mcp-rollback-not-a-time",
    ]),
    "gitlab-mcp-rollback-300",
  );
  assert.equal(selectRollbackToKeep(["gitlab-mcp"]), null);
});

test("selectPrunableContainerNames removes only deployment-owned stale state", () => {
  assert.deepEqual(
    selectPrunableContainerNames(
      [
        "gitlab-mcp",
        "gitlab-mcp-rollback-100",
        "gitlab-mcp-rollback-300",
        "gitlab-mcp-candidate-abcdef123456",
        "gitlab-mcp-failed-200",
        "unrelated-service",
      ],
      "gitlab-mcp-rollback-300",
    ),
    [
      "gitlab-mcp-candidate-abcdef123456",
      "gitlab-mcp-failed-200",
      "gitlab-mcp-rollback-100",
    ],
  );
});

test("selectPrunableContainerNames preserves rollback state when identity is unproven", () => {
  assert.deepEqual(
    selectPrunableContainerNames(
      [
        "gitlab-mcp-rollback-100",
        "gitlab-mcp-rollback-300",
        "gitlab-mcp-candidate-abcdef123456",
        "gitlab-mcp-failed-200",
      ],
      "gitlab-mcp-rollback-300",
      false,
    ),
    ["gitlab-mcp-candidate-abcdef123456", "gitlab-mcp-failed-200"],
  );
});

test("selectPrunableReleaseNames keeps current and rollback checkouts", () => {
  assert.deepEqual(
    selectPrunableReleaseNames(
      [
        current,
        `${current}-deploy`,
        rollback,
        `${rollback}-deploy`,
        stale,
        `${stale}-deploy`,
        "notes",
      ],
      [current, rollback],
    ),
    [stale, `${stale}-deploy`],
  );
});

test("selectPrunableImageTags keeps current and rollback image tags", () => {
  assert.deepEqual(
    selectPrunableImageTags(
      [
        `gitlab-mcp:sha-${current}`,
        `gitlab-mcp:sha-${rollback}`,
        `gitlab-mcp:sha-${stale}`,
        "gitlab-mcp:latest",
        "other:sha-deadbeef",
      ],
      [current, rollback],
    ),
    [`gitlab-mcp:sha-${stale}`],
  );
});

test("commit validation is deliberately exact", () => {
  assert.equal(isCommitSha(current), true);
  assert.equal(isCommitSha("A".repeat(40)), false);
  assert.equal(isCommitSha("a".repeat(39)), false);
  assert.equal(isCommitSha("unknown"), false);
});
