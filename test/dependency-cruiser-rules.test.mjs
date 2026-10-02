import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDependencyCruiserForbiddenRules } from "../.dependency-cruiser-rules.mjs";

const PATHS = {
  production: "^production/",
  tests: "^tests/",
  core: "^core/",
  shared: "^shared/",
  adapters: "^adapters/",
  coreInternals: "^core/",
  platformInternals: "^platform/internal/",
  platformComposition: "^platform/composition\\.mjs$",
  repositoryInternals: "^repository/internal/",
  repositoryComposition: "^repository/composition\\.mjs$",
  mergeRequestInternals: "^merge-request/internal/",
  mergeRequestComposition: "^merge-request/composition\\.mjs$",
  httpInternals: "^http/internal/",
  httpFacade: "^http/facade\\.mjs$",
  httpFoundations: "^http/foundations/",
  httpComposition: "^http/composition/",
};

function createConfig(adaptersDirectory, tolerateMissingAdapters = false) {
  return {
    forbidden: createDependencyCruiserForbiddenRules({
      paths: PATHS,
      adaptersDirectory,
      tolerateMissingAdapters,
    }),
  };
}

function ruleByName(config, name) {
  const rule = config.forbidden.find((candidate) => candidate.name === name);
  assert.ok(rule, `Expected dependency-cruiser rule ${name}.`);
  return rule;
}

function assertIsolationRule(rule, ownAdapter, otherAdapter) {
  const ownPath = `adapters/${ownAdapter}/index.mjs`;
  const otherPath = `adapters/${otherAdapter}/index.mjs`;

  assert.match(ownPath, new RegExp(rule.from.path));
  assert.match(otherPath, new RegExp(rule.to.path));
  assert.match(ownPath, new RegExp(rule.to.pathNot));
  assert.doesNotMatch(otherPath, new RegExp(rule.to.pathNot));
}

describe("dependency-cruiser rule factory", () => {
  it("generates isolation rules for every discovered adapter", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "depcruise-rules-"));
    const adaptersDirectory = join(tempRoot, "adapters");

    try {
      mkdirSync(join(adaptersDirectory, "claude"), { recursive: true });
      mkdirSync(join(adaptersDirectory, "codex"), { recursive: true });

      const config = createConfig(adaptersDirectory);
      const claudeIsolation = ruleByName(
        config,
        "no-claude-adapter-depends-on-other-adapters",
      );
      const codexIsolation = ruleByName(
        config,
        "no-codex-adapter-depends-on-other-adapters",
      );

      assertIsolationRule(claudeIsolation, "claude", "codex");
      assertIsolationRule(codexIsolation, "codex", "claude");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("only tolerates a missing adapter directory when requested", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "depcruise-rules-"));
    const missingDirectory = join(tempRoot, "missing-adapters");

    try {
      const toleratedConfig = createConfig(missingDirectory, true);
      assert.equal(
        toleratedConfig.forbidden.some((rule) =>
          rule.name.endsWith("-adapter-depends-on-other-adapters"),
        ),
        false,
      );

      assert.throws(
        () => createConfig(missingDirectory),
        (error) => error?.code === "ENOENT",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("propagates non-ENOENT adapter discovery errors when tolerance is enabled", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "depcruise-rules-"));
    const notDirectory = join(tempRoot, "not-a-directory");

    try {
      writeFileSync(notDirectory, "fixture");
      assert.throws(
        () => createConfig(notDirectory, true),
        (error) => error?.code && error.code !== "ENOENT",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
