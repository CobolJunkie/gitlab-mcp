import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CORE_FORBIDDEN = [
  /\.codex-plugin/,
  /adapters[/\\]codex/,
  /__CODEX_PLUGIN_METADATA__/,
  /gitlab-codex-plugin/,
];
const SHARED_SKILL_FORBIDDEN = [/\bcodex\//i];

async function collectFiles(directory, pattern) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, pattern)));
    } else if (pattern.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function findViolations(files, patterns) {
  const violations = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        violations.push(`${relative(ROOT, file)} matches ${pattern}`);
      }
    }
  }
  return violations;
}

test("canonical core and shared seam contain no Codex-specific implementation references", async () => {
  const files = [
    ...(await collectFiles(resolve(ROOT, "server/src"), /\.(mjs|js|cjs)$/)),
    ...(await collectFiles(resolve(ROOT, "shared"), /\.(mjs|js|cjs)$/)),
  ];
  assert.deepEqual(await findViolations(files, CORE_FORBIDDEN), []);
});

test("canonical shared skills do not impose harness-specific branch conventions", async () => {
  const files = await collectFiles(resolve(ROOT, "skills"), /\.md$/);
  assert.deepEqual(await findViolations(files, SHARED_SKILL_FORBIDDEN), []);
});

test("Codex adapter owns Codex manifest discovery and uses only the shared seam", async () => {
  const content = await readFile(
    resolve(ROOT, "adapters/codex/preload.mjs"),
    "utf8",
  );
  assert.match(content, /\.codex-plugin\/plugin\.json/);
  assert.match(content, /shared\/distribution-metadata\.mjs/);
  assert.doesNotMatch(content, /server\/src/);
});
