import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildCurrentSurfaceSnapshot } from "../scripts/lib/current-surface-snapshot.mjs";
import {
  APPROVED_POST_BASELINE_READ_ONLY_TOOL_ADDITIONS,
  APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  assertApprovedPostBaselineAdditions,
  assertPreToolsetBaselineContent,
  assertPreToolsetBaselineRewrite,
  assertPreToolsetBaselineSource,
  assertPreToolsetMembership,
  PRE_TOOLSET_BASELINE_SOURCE,
} from "../scripts/lib/pre-toolset-baseline.mjs";
import {
  auditCanonicalSurfaces,
  buildBaselineDocument,
  canonicalJson,
  estimateTokens,
  measureSurface,
  serializedBytes,
  validateReferenceRegistry,
} from "../scripts/lib/surface-audit.mjs";
import { registerGitLabTools } from "../server/src/tools.mjs";

const baselineUrl = new URL(
  "../benchmarks/surface-baseline.json",
  import.meta.url,
);
const currentSurfaceUrl = new URL(
  "../benchmarks/surface-current.json",
  import.meta.url,
);
const referencesUrl = new URL(
  "../benchmarks/external-references.json",
  import.meta.url,
);

const completeReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

test("canonical schema accounting is deterministic and family-aware", () => {
  const tools = [
    {
      name: "write_b",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: "read_a",
      description: "read",
      inputSchema: { properties: {}, type: "object" },
      annotations: completeReadAnnotations,
    },
  ];
  const metadata = [
    {
      name: "read_a",
      family: "repository",
      access: "read",
      destructive: false,
      safetyAnnotationsComplete: true,
    },
    {
      name: "write_b",
      family: "repository",
      access: "write",
      destructive: true,
      safetyAnnotationsComplete: true,
    },
  ];

  const measured = measureSurface(tools, metadata, { mode: "fixture" });
  assert.equal(measured.toolCount, 2);
  assert.equal(measured.readToolCount, 1);
  assert.equal(measured.writeToolCount, 1);
  assert.equal(measured.destructiveToolCount, 1);
  assert.deepEqual(
    measured.tools.map(({ name }) => name),
    ["read_a", "write_b"],
  );
  assert.equal(measured.families.length, 1);
  assert.equal(measured.families[0].family, "repository");
  assert.equal(
    measured.serializedSchemaBytes,
    serializedBytes(tools.reverse()),
  );
  assert.equal(estimateTokens(5), 2);
  assert.match(measured.definitionFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    canonicalJson({ z: 1, ä: 2, a: 3, A: 4 }),
    '{"A":4,"a":3,"z":1,"ä":2}',
  );
});

test("surface measurement rejects incomplete registration metadata", () => {
  const tool = {
    name: "orphan",
    inputSchema: { type: "object" },
    annotations: completeReadAnnotations,
  };
  assert.throws(
    () =>
      measureSurface(
        [tool],
        [
          {
            name: "orphan",
            family: "unclassified",
            access: "read",
            destructive: false,
            safetyAnnotationsComplete: true,
          },
        ],
        { mode: "fixture" },
      ),
    /stable registration family/,
  );
});

test("surface measurement cross-checks registration metadata against tools/list annotations", () => {
  const tool = {
    name: "read_a",
    inputSchema: { type: "object" },
    annotations: completeReadAnnotations,
  };
  assert.throws(
    () =>
      measureSurface(
        [tool],
        [
          {
            name: "read_a",
            family: "repository",
            access: "write",
            destructive: true,
            safetyAnnotationsComplete: true,
          },
        ],
        { mode: "fixture" },
      ),
    /does not match MCP-visible safety annotations/,
  );
});

test("benchmarking leaves the production registration return contract unchanged", () => {
  const collectorServer = { registerTool() {} };
  assert.equal(
    registerGitLabTools(collectorServer, {
      clientFactory: () => {
        throw new Error("Registration contract test must not call GitLab.");
      },
    }),
    undefined,
  );
});

test("baseline provenance rejects ambiguous source identifiers and invalid dates", () => {
  const surfaces = { all: {}, readOnly: {} };
  assert.throws(
    () =>
      buildBaselineDocument({
        source: { commit: "abc1234", capturedAt: "2026-08-17" },
        surfaces,
      }),
    /full 40-character hexadecimal Git SHA/,
  );
  assert.throws(
    () =>
      buildBaselineDocument({
        source: { commit: "a".repeat(40), capturedAt: "2026-02-30" },
        surfaces,
      }),
    /real calendar date/,
  );
  assert.throws(
    () =>
      buildCurrentSurfaceSnapshot({
        source: { commit: "abc1234", capturedAt: "2026-09-16" },
        surfaces,
      }),
    /full 40-character hexadecimal Git SHA/,
  );
});

test("frozen pre-toolset baseline provenance cannot drift silently", () => {
  assert.equal(
    assertPreToolsetBaselineSource(PRE_TOOLSET_BASELINE_SOURCE),
    true,
  );
  assert.throws(
    () =>
      assertPreToolsetBaselineSource({
        ...PRE_TOOLSET_BASELINE_SOURCE,
        commit: "a".repeat(40),
      }),
    /must remain pinned/,
  );
  assert.throws(
    () =>
      assertPreToolsetBaselineSource({
        ...PRE_TOOLSET_BASELINE_SOURCE,
        capturedAt: "2026-08-18",
      }),
    /must remain pinned/,
  );
  assert.throws(
    () =>
      assertPreToolsetBaselineSource({
        ...PRE_TOOLSET_BASELINE_SOURCE,
        note: "silently broaden provenance",
      }),
    /must remain pinned/,
  );
});

test("frozen pre-toolset baseline content cannot drift silently", async () => {
  const content = await readFile(baselineUrl, "utf8");
  assert.equal(assertPreToolsetBaselineContent(content), true);
  assert.throws(
    () => assertPreToolsetBaselineContent(`${content} `),
    /must remain byte-for-byte identical/,
  );
});

test("frozen pre-toolset baseline cannot be overwritten by surface drift", () => {
  const surfaces = {
    all: { toolCount: 1 },
    readOnly: { toolCount: 1 },
  };
  const existing = buildBaselineDocument({
    source: PRE_TOOLSET_BASELINE_SOURCE,
    surfaces,
  });
  const identical = structuredClone(existing);
  assert.equal(assertPreToolsetBaselineRewrite(existing, identical), true);

  const drifted = structuredClone(existing);
  drifted.surfaces.all.toolCount = 2;
  assert.throws(
    () => assertPreToolsetBaselineRewrite(existing, drifted),
    /must not be overwritten/,
  );
});

test("approved post-baseline additions are exact in full and read-only surfaces", async () => {
  const current = await auditCanonicalSurfaces();
  const historical = await auditCanonicalSurfaces({
    excludeToolNames: APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  });

  assert.equal(assertApprovedPostBaselineAdditions(current, historical), true);
  const historicalNames = new Set(historical.all.tools.map(({ name }) => name));
  const historicalReadNames = new Set(
    historical.readOnly.tools.map(({ name }) => name),
  );
  assert.deepEqual(
    current.all.tools
      .map(({ name }) => name)
      .filter((name) => !historicalNames.has(name)),
    [...APPROVED_POST_BASELINE_TOOL_ADDITIONS].sort(),
  );
  assert.deepEqual(
    current.readOnly.tools
      .map(({ name }) => name)
      .filter((name) => !historicalReadNames.has(name)),
    [...APPROVED_POST_BASELINE_READ_ONLY_TOOL_ADDITIONS].sort(),
  );

  const unexpected = structuredClone(current);
  unexpected.all.tools.push({ name: "unexpected_tool" });
  assert.throws(
    () => assertApprovedPostBaselineAdditions(unexpected, historical),
    /only by approved additions/,
  );
});

test("frozen pre-toolset membership rejects same-count substitutions", async () => {
  const historical = await auditCanonicalSurfaces({
    excludeToolNames: APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  });
  assert.equal(assertPreToolsetMembership(historical), true);

  for (const mode of ["all", "readOnly"]) {
    const drifted = structuredClone(historical);
    drifted[mode].tools[0].name = `unexpected_${mode}_replacement`;
    assert.throws(
      () => assertPreToolsetMembership(drifted),
      /must match the frozen contract snapshot/,
    );
  }
});

test("external reference registry has provenance and informational measurements", async () => {
  const registry = JSON.parse(await readFile(referencesUrl, "utf8"));
  assert.equal(validateReferenceRegistry(registry), true);
  assert.ok(registry.references.length >= 3);

  const missingProvenance = structuredClone(registry);
  delete missingProvenance.references[0].provenance;
  assert.throws(
    () => validateReferenceRegistry(missingProvenance),
    /missing provenance/,
  );

  const incompleteProvenance = structuredClone(registry);
  incompleteProvenance.references[0].provenance = {
    kind: "local_capture",
  };
  assert.throws(
    () => validateReferenceRegistry(incompleteProvenance),
    /kind and source or path/,
  );

  const wrongClassification = structuredClone(registry);
  wrongClassification.classification = "benchmark";
  assert.throws(
    () => validateReferenceRegistry(wrongClassification),
    /classification reference/,
  );
});

test("canonical MCP membership preserves the frozen pre-toolset boundary", async () => {
  const baselineContent = await readFile(baselineUrl, "utf8");
  assert.equal(assertPreToolsetBaselineContent(baselineContent), true);
  const expected = JSON.parse(baselineContent);
  assert.deepEqual(expected.source, PRE_TOOLSET_BASELINE_SOURCE);
  const current = await auditCanonicalSurfaces();
  const historical = await auditCanonicalSurfaces({
    excludeToolNames: APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  });
  assert.equal(assertPreToolsetMembership(historical), true);
  assert.equal(assertApprovedPostBaselineAdditions(current, historical), true);

  assert.equal(historical.all.toolCount, 147);
  assert.equal(historical.all.tools.length, 147);
  assert.equal(historical.readOnly.toolCount, 81);
  assert.equal(historical.readOnly.tools.length, 81);
  assert.equal(current.all.toolCount, 175);
  assert.equal(current.readOnly.toolCount, 87);
  assert.equal(historical.readOnly.writeToolCount, 0);
  assert.equal(historical.readOnly.destructiveToolCount, 0);
  assert.ok(historical.all.families.length >= 10);
  assert.ok(
    historical.all.tools.every((tool) => tool.family !== "unclassified"),
  );
  assert.equal(expected.surfaces.all.toolCount, 147);
  assert.equal(expected.surfaces.readOnly.toolCount, 81);
});

test("canonical MCP surface matches the reviewed current-surface snapshot", async () => {
  const expected = JSON.parse(await readFile(currentSurfaceUrl, "utf8"));
  const surfaces = await auditCanonicalSurfaces();
  const actual = buildCurrentSurfaceSnapshot({
    source: expected.source,
    surfaces,
  });

  assert.equal(surfaces.all.toolCount, 175);
  assert.equal(surfaces.readOnly.toolCount, 87);
  assert.equal(surfaces.all.readToolCount, 87);
  assert.equal(surfaces.all.writeToolCount, 88);
  assert.equal(surfaces.all.destructiveToolCount, 30);
  assert.equal(surfaces.readOnly.writeToolCount, 0);
  assert.equal(surfaces.readOnly.destructiveToolCount, 0);
  assert.ok(surfaces.all.tools.every((tool) => tool.family !== "unclassified"));

  const expectedCanonical = canonicalJson(expected);
  const actualCanonical = canonicalJson(actual);
  if (expectedCanonical !== actualCanonical) {
    console.error("Generated current surface snapshot follows:");
    console.error(JSON.stringify(actual, null, 2));
  }
  assert.equal(actualCanonical, expectedCanonical);
});
