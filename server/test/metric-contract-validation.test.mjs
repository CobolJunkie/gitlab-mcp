import assert from "node:assert/strict";
import test from "node:test";

import { validateMetricContract } from "../src/metric-contract.mjs";

function metric(overrides = {}) {
  return {
    type: "counter",
    unit: "{event}",
    description: "Contract validation fixture.",
    privacy: "non-sensitive",
    stability: "experimental",
    cardinalityBudget: 2,
    attributes: {},
    requiredAttributes: [],
    ...overrides,
  };
}

function validate(definition) {
  return validateMetricContract({
    schemaVersion: 1,
    metrics: { "gitlab_mcp.fixture": definition },
  });
}

test("contract validation requires histogram-only finite increasing boundaries", () => {
  assert.deepEqual(
    validate(metric({ type: "histogram", boundaries: [0.1, 0.1, 1] })),
    ["gitlab_mcp.fixture: invalid histogram boundaries."],
  );
  assert.deepEqual(
    validate(metric({ type: "histogram", boundaries: [0.1, Number.NaN, 1] })),
    ["gitlab_mcp.fixture: invalid histogram boundaries."],
  );
  assert.deepEqual(
    validate(metric({ type: "histogram", boundaries: [0.1, 1, 10] })),
    [],
  );
  assert.deepEqual(validate(metric({ boundaries: [1, 2, 3] })), [
    "gitlab_mcp.fixture: boundaries are supported only for histograms.",
  ]);
});

test("contract validation accepts only one supported attribute definition form", () => {
  assert.deepEqual(
    validate(
      metric({
        attributes: { tool: { kind: "arbitrary" } },
        requiredAttributes: ["tool"],
      }),
    ),
    ["gitlab_mcp.fixture.tool: unsupported attribute kind."],
  );
  assert.deepEqual(
    validate(
      metric({
        attributes: { tool: { kind: "identifier", values: ["get_issue"] } },
        requiredAttributes: ["tool"],
      }),
    ),
    [
      "gitlab_mcp.fixture.tool: attribute cannot define both kind and enum values.",
    ],
  );
  assert.deepEqual(
    validate(
      metric({
        attributes: { tool: { kind: "identifier" } },
        requiredAttributes: ["tool"],
      }),
    ),
    [],
  );
});

test("contract validation rejects unreviewed privacy dimensions and enum values", () => {
  assert.deepEqual(
    validate(
      metric({
        attributes: { project_id: { values: ["123"] } },
        requiredAttributes: ["project_id"],
      }),
    ),
    ["gitlab_mcp.fixture.project_id: unsupported metric attribute."],
  );
  assert.deepEqual(
    validate(
      metric({
        attributes: { reason: { values: ["private/project"] } },
        requiredAttributes: ["reason"],
      }),
    ),
    ["gitlab_mcp.fixture.reason: invalid enum values."],
  );
  assert.deepEqual(
    validate(
      metric({
        attributes: { tool: { values: ["get_issue"] } },
        requiredAttributes: ["tool"],
      }),
    ),
    ["gitlab_mcp.fixture.tool: invalid enum values."],
  );
});

test("contract validation enforces privacy and stability classifications", () => {
  assert.deepEqual(validate(metric({ privacy: "sensitive" })), [
    "gitlab_mcp.fixture: unsupported privacy classification.",
  ]);
  assert.deepEqual(validate(metric({ stability: "stable" })), [
    "gitlab_mcp.fixture: unsupported stability status.",
  ]);
  assert.deepEqual(
    validateMetricContract({
      schemaVersion: 1,
      stability: "stable",
      metrics: { "gitlab_mcp.fixture": metric() },
    }),
    ["Metric contract: unsupported stability status."],
  );
});

test("contract validation rejects malformed document and metric shapes without throwing", () => {
  const shapeError =
    "Metric contract must declare schemaVersion 1 and a metrics object.";
  for (const document of [
    null,
    [],
    { schemaVersion: 1, metrics: [] },
    { schemaVersion: 1, metrics: {} },
  ]) {
    assert.doesNotThrow(() => validateMetricContract(document));
    assert.deepEqual(validateMetricContract(document), [shapeError]);
  }

  assert.deepEqual(validate(null), [
    "gitlab_mcp.fixture: metric definition must be an object.",
  ]);
  assert.deepEqual(validate([]), [
    "gitlab_mcp.fixture: metric definition must be an object.",
  ]);
  assert.deepEqual(validate(metric({ attributes: [] })), [
    "gitlab_mcp.fixture: attributes must be an object.",
  ]);
  assert.deepEqual(
    validate(
      metric({
        attributes: { outcome: null },
        requiredAttributes: ["outcome"],
      }),
    ),
    ["gitlab_mcp.fixture.outcome: attribute definition must be an object."],
  );
});

test("contract validation rejects invalid metric names and non-string metadata", () => {
  assert.deepEqual(
    validateMetricContract({
      schemaVersion: 1,
      metrics: { "gitlab_mcp.bad metric": metric() },
    }),
    ["gitlab_mcp.bad metric: invalid metric name."],
  );
  assert.deepEqual(validate(metric({ unit: 1 })), [
    "gitlab_mcp.fixture: incomplete metadata.",
  ]);
  assert.deepEqual(validate(metric({ description: {} })), [
    "gitlab_mcp.fixture: incomplete metadata.",
  ]);
});
