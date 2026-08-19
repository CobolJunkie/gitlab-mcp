import assert from "node:assert/strict";
import test from "node:test";

import { validateHarnessPackage } from "../scripts/harness-package-validation.mjs";

const BASE_OPTIONS = {
  artifactName: "harness-validation-test",
  packageFiles: ["LICENSE"],
  distributionMetadataPath: "distribution.json",
  harnessLabel: "Harness test",
  clientNamePrefix: "harness-test",
  probeEnvironment: {},
  excludedPackagePaths: [],
  validateHarness() {
    throw new Error("Invalid package paths must fail before validation.");
  },
};

function validate(overrides) {
  return validateHarnessPackage({ ...BASE_OPTIONS, ...overrides });
}

test("rejects unsafe harness artifact names", async () => {
  const artifactNames = ["../outside", "/absolute", "C:\\outside"];
  for (const artifactName of artifactNames) {
    await assert.rejects(validate({ artifactName }), /artifact name must be/);
  }
});

test("rejects package mappings outside package boundaries", async () => {
  const mappings = [
    { source: "../LICENSE", target: "LICENSE" },
    { source: "LICENSE", target: "../outside" },
    { source: "/absolute", target: "LICENSE" },
    { source: "LICENSE", target: "C:\\outside" },
    { source: "C:outside", target: "LICENSE" },
    { source: "LICENSE", target: "C:outside" },
  ];
  for (const mapping of mappings) {
    await assert.rejects(
      validate({ packageFiles: [mapping] }),
      /package-relative path/,
    );
  }
});

test("rejects duplicate package targets", async () => {
  const packageFiles = [
    { source: "LICENSE", target: "same.txt" },
    { source: "distribution.json", target: "same.txt" },
  ];
  await assert.rejects(
    validate({ packageFiles }),
    /target same\.txt must be unique/,
  );
});

test("rejects overlapping package target hierarchies", async () => {
  const packageFiles = [
    { source: "LICENSE", target: "nested" },
    { source: "distribution.json", target: "nested/file.json" },
  ];
  await assert.rejects(
    validate({ packageFiles }),
    /target nested\/file\.json must not overlap harness package target nested/,
  );
});

test("rejects package targets overlapping canonical content", async () => {
  const targets = [
    "server",
    "server/dist/gitlab-mcp.cjs",
    "skills",
    "skills/gitlab/SKILL.md",
  ];
  for (const target of targets) {
    await assert.rejects(
      validate({ packageFiles: [{ source: "LICENSE", target }] }),
      /must not overlap canonical (?:MCP bundle|Skills directory)/,
    );
  }
});

test("validates package-relative metadata paths", async () => {
  await assert.rejects(
    validate({ distributionMetadataPath: "../distribution.json" }),
    /distribution metadata path must be a package-relative path/,
  );
  await assert.rejects(
    validate({ excludedPackagePaths: ["../adapters"] }),
    /Excluded package path 0 must be a package-relative path/,
  );
});
