import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import productionConfig from "../.dependency-cruiser.mjs";
import fixtureConfig from "../test-dependency-boundaries/.dependency-cruiser-test.mjs";

const execAsync = promisify(exec);
const CONFIG = "test-dependency-boundaries/.dependency-cruiser-test.mjs";

async function runDepCruise(target) {
  const cmd = `npx depcruise "${target}" --config "${CONFIG}" --output-type err`;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: process.cwd(),
      timeout: 30_000,
      shell: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: error.code || 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function assertViolation(result, ruleName) {
  assert.notEqual(result.exitCode, 0, `Expected ${ruleName} to fail.`);
  const output = result.stdout + result.stderr;
  assert.ok(
    output.includes(ruleName),
    `Expected ${ruleName} in output but got: ${output.slice(0, 600)}`,
  );
}

function ruleNames(config) {
  return config.forbidden.map((rule) => rule.name);
}

function ruleByName(config, name) {
  const rule = config.forbidden.find((candidate) => candidate.name === name);
  assert.ok(rule, `Expected dependency-cruiser rule ${name}.`);
  return rule;
}

function assertPathMatches(pattern, path) {
  assert.match(
    path,
    new RegExp(pattern),
    `Expected ${path} to match ${pattern}.`,
  );
}

function assertPathDoesNotMatch(pattern, path) {
  assert.doesNotMatch(
    path,
    new RegExp(pattern),
    `Expected ${path} not to match ${pattern}.`,
  );
}

describe("dependency-cruiser boundary rules", () => {
  it("uses the same forbidden rule set as production", () => {
    assert.deepEqual(ruleNames(fixtureConfig), ruleNames(productionConfig));
  });

  it("keeps production path predicates aligned with repository architecture", () => {
    const productionOnTest = ruleByName(
      productionConfig,
      "no-production-on-test",
    );
    for (const path of [
      "server/src/index.mjs",
      "scripts/build.mjs",
      "skills/gitlab/SKILL.md",
      "shared/tooling.mjs",
      "adapters/codex/index.mjs",
    ]) {
      assertPathMatches(productionOnTest.from.path, path);
    }
    for (const path of [
      "server/test/index.test.mjs",
      "server/src-old/index.mjs",
      "scripts-old/build.mjs",
      "skills-old/gitlab/SKILL.md",
      "shared-old/tooling.mjs",
      "adapters-legacy/codex/index.mjs",
    ]) {
      assertPathDoesNotMatch(productionOnTest.from.path, path);
    }
    for (const path of [
      "server/test/index.test.mjs",
      "test/dependency-boundaries.test.mjs",
      "test-dependency-boundaries/fixtures/helper.mjs",
    ]) {
      assertPathMatches(productionOnTest.to.path, path);
    }
    assertPathDoesNotMatch(productionOnTest.to.path, "server/src/index.mjs");

    const coreOnAdapters = ruleByName(
      productionConfig,
      "no-core-depends-on-adapters",
    );
    assertPathMatches(coreOnAdapters.from.path, "server/src/index.mjs");
    assertPathDoesNotMatch(coreOnAdapters.from.path, "shared/tooling.mjs");
    assertPathMatches(coreOnAdapters.to.path, "adapters/codex/index.mjs");
    assertPathDoesNotMatch(coreOnAdapters.to.path, "server/src/index.mjs");

    const sharedOnAdapters = ruleByName(
      productionConfig,
      "no-shared-depends-on-adapters",
    );
    assertPathMatches(sharedOnAdapters.from.path, "skills/gitlab/SKILL.md");
    assertPathMatches(sharedOnAdapters.from.path, "shared/tooling.mjs");
    assertPathDoesNotMatch(sharedOnAdapters.from.path, "server/src/index.mjs");
    assertPathMatches(sharedOnAdapters.to.path, "adapters/codex/index.mjs");
    assertPathDoesNotMatch(sharedOnAdapters.to.path, "shared/tooling.mjs");

    const adapterOnCore = ruleByName(
      productionConfig,
      "no-adapter-depends-on-core-internals",
    );
    assertPathMatches(adapterOnCore.from.path, "adapters/codex/index.mjs");
    assertPathDoesNotMatch(adapterOnCore.from.path, "shared/tooling.mjs");
    assertPathMatches(adapterOnCore.to.path, "server/src/index.mjs");
    assertPathDoesNotMatch(adapterOnCore.to.path, "adapters/codex/index.mjs");

    const platformOnComposition = ruleByName(
      productionConfig,
      "no-platform-internals-depend-on-composition",
    );
    assertPathMatches(
      platformOnComposition.from.path,
      "server/src/tools/platform/discovery-tools.mjs",
    );
    assertPathDoesNotMatch(
      platformOnComposition.from.path,
      "server/src/tools/platform-tools.mjs",
    );
    assertPathMatches(
      platformOnComposition.to.path,
      "server/src/tools/platform-tools.mjs",
    );
    assertPathDoesNotMatch(
      platformOnComposition.to.path,
      "server/src/tools/platform/discovery-tools.mjs",
    );

    const repositoryOnComposition = ruleByName(
      productionConfig,
      "no-repository-internals-depend-on-composition",
    );
    assertPathMatches(
      repositoryOnComposition.from.path,
      "server/src/tools/repository/branch-tools.mjs",
    );
    assertPathDoesNotMatch(
      repositoryOnComposition.from.path,
      "server/src/tools/repository-tools.mjs",
    );
    assertPathMatches(
      repositoryOnComposition.to.path,
      "server/src/tools/repository-tools.mjs",
    );
    assertPathDoesNotMatch(
      repositoryOnComposition.to.path,
      "server/src/tools/repository/branch-tools.mjs",
    );

    const mergeRequestOnComposition = ruleByName(
      productionConfig,
      "no-merge-request-internals-depend-on-composition",
    );
    assertPathMatches(
      mergeRequestOnComposition.from.path,
      "server/src/tools/merge-request/suggestion-tools.mjs",
    );
    assertPathDoesNotMatch(
      mergeRequestOnComposition.from.path,
      "server/src/tools/merge-request-tools.mjs",
    );
    assertPathMatches(
      mergeRequestOnComposition.to.path,
      "server/src/tools/merge-request-tools.mjs",
    );

    const httpOnFacade = ruleByName(
      productionConfig,
      "no-http-internals-depend-on-public-facade",
    );
    assertPathMatches(httpOnFacade.from.path, "server/src/http/auth.mjs");
    assertPathDoesNotMatch(httpOnFacade.from.path, "server/src/http.mjs");
    assertPathMatches(httpOnFacade.to.path, "server/src/http.mjs");
    assertPathDoesNotMatch(httpOnFacade.to.path, "server/src/http/app.mjs");

    const httpFoundationsOnComposition = ruleByName(
      productionConfig,
      "no-http-foundations-depend-on-composition",
    );
    for (const path of [
      "server/src/http/policy.mjs",
      "server/src/http/admission.mjs",
      "server/src/http/auth.mjs",
      "server/src/http/readiness.mjs",
    ]) {
      assertPathMatches(httpFoundationsOnComposition.from.path, path);
    }
    assertPathDoesNotMatch(
      httpFoundationsOnComposition.from.path,
      "server/src/http/app.mjs",
    );
    assertPathMatches(
      httpFoundationsOnComposition.to.path,
      "server/src/http/app.mjs",
    );
    assertPathMatches(
      httpFoundationsOnComposition.to.path,
      "server/src/http/lifecycle.mjs",
    );
    assertPathDoesNotMatch(
      httpFoundationsOnComposition.to.path,
      "server/src/http/auth.mjs",
    );

    const codexIsolation = ruleByName(
      productionConfig,
      "no-codex-adapter-depends-on-other-adapters",
    );
    assertPathMatches(codexIsolation.from.path, "adapters/codex/index.mjs");
    assertPathDoesNotMatch(
      codexIsolation.from.path,
      "adapters/claude/index.mjs",
    );
    assertPathMatches(codexIsolation.to.path, "adapters/claude/index.mjs");
    assertPathMatches(codexIsolation.to.pathNot, "adapters/codex/internal.mjs");
    assertPathDoesNotMatch(
      codexIsolation.to.pathNot,
      "adapters/claude/index.mjs",
    );
  });

  it("detects circular dependencies", async () => {
    assertViolation(
      await runDepCruise("test-dependency-boundaries/circular-a.mjs"),
      "no-circular",
    );
  });

  it("rejects production to test dependencies", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/production/imports-test-fixture.mjs",
      ),
      "no-production-on-test",
    );
  });

  it("rejects core to adapter dependencies", async () => {
    assertViolation(
      await runDepCruise("test-dependency-boundaries/core/imports-adapter.mjs"),
      "no-core-depends-on-adapters",
    );
  });

  it("rejects shared skill to adapter dependencies", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/skills/imports-adapter.mjs",
      ),
      "no-shared-depends-on-adapters",
    );
  });

  it("rejects shared seam to adapter dependencies", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/shared/imports-adapter.mjs",
      ),
      "no-shared-depends-on-adapters",
    );
  });

  it("rejects adapter to core dependencies", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/adapters/codex/imports-core.mjs",
      ),
      "no-adapter-depends-on-core-internals",
    );
  });

  it("rejects platform internals importing the composition boundary", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/platform/internal/imports-composition.mjs",
      ),
      "no-platform-internals-depend-on-composition",
    );
  });

  it("rejects repository internals importing the composition boundary", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/repository/internal/imports-composition.mjs",
      ),
      "no-repository-internals-depend-on-composition",
    );
  });

  it("rejects merge-request internals importing the composition boundary", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/merge-request/internal/imports-composition.mjs",
      ),
      "no-merge-request-internals-depend-on-composition",
    );
  });

  it("rejects HTTP internals importing the public facade", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/http/internal/imports-facade.mjs",
      ),
      "no-http-internals-depend-on-public-facade",
    );
  });

  it("rejects HTTP foundations importing app or lifecycle composition", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/http/foundations/imports-composition.mjs",
      ),
      "no-http-foundations-depend-on-composition",
    );
  });

  it("rejects cross-adapter dependencies", async () => {
    assertViolation(
      await runDepCruise(
        "test-dependency-boundaries/adapters/codex/imports-claude.mjs",
      ),
      "no-codex-adapter-depends-on-other-adapters",
    );
  });

  it("allows imports within one adapter", async () => {
    const result = await runDepCruise(
      "test-dependency-boundaries/adapters/codex/internal.mjs",
    );
    assert.equal(
      result.exitCode,
      0,
      `Expected same-adapter dependency to pass: ${(result.stdout + result.stderr).slice(0, 600)}`,
    );
  });
});
