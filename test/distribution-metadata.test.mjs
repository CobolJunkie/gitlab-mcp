import assert from "node:assert/strict";
import test from "node:test";

import {
  getDistributionMetadata,
  normalizeDistributionMetadata,
  resolveDistributionMetadata,
  setDistributionMetadata,
} from "../shared/distribution-metadata.mjs";

const DISTRIBUTION_METADATA_KEY = Symbol.for(
  "@local/gitlab-mcp/distribution-metadata",
);

test("distribution metadata normalization validates, trims, and freezes", () => {
  const normalized = normalizeDistributionMetadata({
    name: " test-harness ",
    version: " 1.2.3 ",
  });
  assert.deepEqual(normalized, { name: "test-harness", version: "1.2.3" });
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(
    () => normalizeDistributionMetadata({ name: "", version: "1.0.0" }),
    /requires non-empty name and version/,
  );
  assert.throws(
    () => normalizeDistributionMetadata(null),
    /requires non-empty name and version/,
  );
});

test("metadata resolution distinguishes inherited, neutral, and explicit identity", () => {
  const current = getDistributionMetadata();
  assert.equal(resolveDistributionMetadata({}), current);
  assert.equal(
    resolveDistributionMetadata({ distributionMetadata: undefined }),
    current,
  );
  assert.equal(
    resolveDistributionMetadata({ distributionMetadata: null }),
    null,
  );
  assert.deepEqual(
    resolveDistributionMetadata({
      distributionMetadata: { name: " example ", version: " 2.0.0 " },
    }),
    { name: "example", version: "2.0.0" },
  );
});

test("process distribution metadata is immutable and write-once", () => {
  const current = getDistributionMetadata();
  const configured =
    current ||
    setDistributionMetadata({
      name: "test-harness",
      version: "1.2.3",
    });

  assert.equal(Object.isFrozen(configured), true);
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    DISTRIBUTION_METADATA_KEY,
  );
  assert.equal(descriptor?.writable, false);
  assert.equal(descriptor?.configurable, false);
  assert.equal(
    setDistributionMetadata({
      name: configured.name,
      version: configured.version,
    }),
    configured,
  );
  assert.throws(
    () => setDistributionMetadata({ name: "other", version: "1.0.0" }),
    /already configured/,
  );
  assert.throws(
    () => setDistributionMetadata(null),
    /requires non-empty name and version/,
  );
});
