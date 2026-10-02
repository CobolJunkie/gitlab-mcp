import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const sonar = await readFile("sonar-project.properties", "utf8");

function property(name) {
  const prefix = `${name}=`;
  const line = sonar
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing ${name}`);
  return line.slice(prefix.length);
}

function sonarPathPattern(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:[^/]+/)*";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (/[-/\\^$+?.()|[\]{}]/u.test(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`, "u");
}

async function listModuleFiles(directory) {
  const files = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listModuleFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

test("Sonar source pattern matching catches indirect operational exclusions", () => {
  assert.equal(
    sonarPathPattern("**/*.mjs").test("scripts/deploy-production.mjs"),
    true,
  );
  assert.equal(
    sonarPathPattern("**/lib/**").test("scripts/lib/surface-audit.mjs"),
    true,
  );
  assert.equal(
    sonarPathPattern("scripts/**").test("scripts/lib/surface-audit.mjs"),
    true,
  );
  assert.equal(
    sonarPathPattern("server/dist/**").test("scripts/lib/surface-audit.mjs"),
    false,
  );
});

test("coverage include classification treats glob metasyntax as non-exact", () => {
  for (const pattern of [
    "scripts/*.mjs",
    "scripts/[a-z]*.mjs",
    "scripts/{deploy-production,check-mcp-candidate}.mjs",
    "scripts/@(deploy-production|check-mcp-candidate).mjs",
  ]) {
    assert.equal(/^[A-Za-z0-9_./-]+$/u.test(pattern), false, pattern);
  }
  assert.equal(
    /^[A-Za-z0-9_./-]+$/u.test("scripts/deploy-production.mjs"),
    true,
  );
});

test("operational script coverage is explicit and complete", async () => {
  const coverageCommand = pkg.scripts["test:coverage"];
  assert.match(
    coverageCommand,
    /--test-coverage-include=scripts\/lib\/\*\*\/\*\.mjs/u,
  );
  assert.match(
    coverageCommand,
    /--test-coverage-include=scripts\/deploy-production\.mjs/u,
  );

  const topLevelScripts = (await readdir("scripts", { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();

  const coverageIncludes = [
    ...coverageCommand.matchAll(/--test-coverage-include=([^\s]+)/gu),
  ].map((match) => match[1]);
  const allowedWildcardIncludes = new Set([
    "server/src/**/*.mjs",
    "shared/**/*.mjs",
    "adapters/**/*.mjs",
    "scripts/lib/**/*.mjs",
  ]);
  const nonExactCoverageIncludes = coverageIncludes
    .filter((pattern) => !/^[A-Za-z0-9_./-]+$/u.test(pattern))
    .filter((pattern) => !allowedWildcardIncludes.has(pattern))
    .sort();
  assert.deepEqual(
    nonExactCoverageIncludes,
    [],
    "coverage wildcard roots must be explicit; top-level operational scripts require exact includes",
  );

  const sonarSources = new Set(
    property("sonar.sources").split(",").filter(Boolean),
  );
  assert.equal(
    sonarSources.has("scripts"),
    true,
    "operational scripts must remain in Sonar source analysis",
  );

  const sourceExclusions = property("sonar.exclusions")
    .split(",")
    .filter(Boolean);
  const operationalModules = await listModuleFiles("scripts");
  const scriptSourceExclusions = sourceExclusions
    .flatMap((pattern) => {
      const matcher = sonarPathPattern(pattern);
      return operationalModules
        .filter((path) => matcher.test(path))
        .map((path) => `${pattern} -> ${path}`);
    })
    .sort();
  assert.deepEqual(
    scriptSourceExclusions,
    [],
    "operational scripts must not be removed from Sonar source analysis",
  );

  const exclusions = new Set(
    property("sonar.coverage.exclusions").split(",").filter(Boolean),
  );
  const wildcardOperationalExclusions = [...exclusions]
    .filter((pattern) => pattern.includes("*") || pattern.includes("?"))
    .flatMap((pattern) => {
      const matcher = sonarPathPattern(pattern);
      return operationalModules
        .filter((path) => matcher.test(path))
        .map((path) => `${pattern} -> ${path}`);
    })
    .sort();
  assert.deepEqual(
    wildcardOperationalExclusions,
    [],
    "operational coverage exclusions must name exact paths rather than wildcard patterns",
  );
  const coveredLibraryExclusions = [...exclusions]
    .filter((path) => path.startsWith("scripts/lib/"))
    .sort();
  assert.deepEqual(
    coveredLibraryExclusions,
    [],
    "covered scripts/lib modules must not be excluded from Sonar coverage",
  );
  assert.equal(exclusions.has("scripts/deploy-production.mjs"), false);

  const directlyCovered = new Set(
    coverageIncludes
      .filter((path) => path.startsWith("scripts/"))
      .filter((path) => /^[A-Za-z0-9_./-]+$/u.test(path)),
  );

  const topLevelScriptSet = new Set(topLevelScripts);
  const contradictory = topLevelScripts.filter(
    (path) => directlyCovered.has(path) && exclusions.has(path),
  );
  assert.deepEqual(
    contradictory,
    [],
    "a top-level operational script cannot be both directly covered and excluded",
  );

  const staleTopLevelIncludes = [...directlyCovered]
    .filter(
      (path) =>
        /^scripts\/[^/]+\.mjs$/u.test(path) && !topLevelScriptSet.has(path),
    )
    .sort();
  assert.deepEqual(
    staleTopLevelIncludes,
    [],
    "directly covered top-level operational scripts must refer to existing files",
  );

  const staleTopLevelExclusions = [...exclusions]
    .filter(
      (path) =>
        /^scripts\/[^/]+\.mjs$/u.test(path) && !topLevelScriptSet.has(path),
    )
    .sort();
  assert.deepEqual(
    staleTopLevelExclusions,
    [],
    "top-level operational script exclusions must refer to existing files",
  );

  const unexplained = topLevelScripts.filter(
    (path) => !directlyCovered.has(path) && !exclusions.has(path),
  );
  assert.deepEqual(
    unexplained,
    [],
    "every top-level operational script must be directly covered or explicitly excluded",
  );
});
