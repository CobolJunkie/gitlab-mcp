import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import yaml from "js-yaml";

const ci = yaml.load(await readFile(".gitlab-ci.yml", "utf8"));

test("formatting is a dedicated blocking verify job", () => {
  const formatting = ci.formatting;
  assert.equal(formatting?.stage, "verify");
  assert.equal(formatting?.extends, ".node-job");
  assert.equal(formatting?.allow_failure, undefined);
  assert.deepEqual(formatting?.script, [
    "apk add --no-cache git",
    "npm run format",
    "node scripts/capture-formatting-fix-artifacts.mjs",
  ]);

  const qualityScript = ci.quality?.script ?? [];
  assert.equal(
    qualityScript.includes("npm run format:check"),
    false,
    "quality must not duplicate the authoritative formatting gate",
  );
  assert.equal(qualityScript.includes("npm run check"), true);
  assert.equal(qualityScript.includes("npm run lint"), true);
});

test("formatting failures persist an exact patch, manifest, and formatted files", () => {
  const artifacts = ci.formatting?.artifacts;
  assert.equal(artifacts?.when, "on_failure");
  assert.equal(artifacts?.expire_in, "1 week");
  assert.deepEqual(artifacts?.paths, [
    "artifacts/formatting/prettier.patch",
    "artifacts/formatting/changed-files.txt",
    "artifacts/formatting/files/",
  ]);
});
