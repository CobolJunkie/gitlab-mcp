import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGitLabMcpServer } from "../../server/src/server.mjs";
import { registerCiVariableTools } from "../../server/src/tools/ci-variable-tools.mjs";
import { registerDeploymentTools } from "../../server/src/tools/deployment-tools.mjs";
import { registerGovernanceTools } from "../../server/src/tools/governance-tools.mjs";
import { registerIssueTools } from "../../server/src/tools/issue-tools.mjs";
import { registerMergeRequestTools } from "../../server/src/tools/merge-request-tools.mjs";
import { registerPipelineScheduleTools } from "../../server/src/tools/pipeline-schedule-tools.mjs";
import { registerPipelineTools } from "../../server/src/tools/pipeline-tools.mjs";
import { registerPlatformTools } from "../../server/src/tools/platform-tools.mjs";
import { registerReleaseTools } from "../../server/src/tools/release-tools.mjs";
import { registerRepositoryTools } from "../../server/src/tools/repository-tools.mjs";
import { registerRuntimeTools } from "../../server/src/tools/runtime-tools.mjs";
import { registerWebhookTools } from "../../server/src/tools/webhook-tools.mjs";

export const SURFACE_BASELINE_SCHEMA_VERSION = 1;
export const TOKEN_ESTIMATOR = Object.freeze({
  id: "utf8-bytes-div-4",
  version: 1,
  bytesPerEstimatedToken: 4,
  description:
    "Deterministic model-neutral estimate: ceil(canonical UTF-8 bytes / 4). Raw byte counts remain authoritative.",
});

const AUDIT_REGISTRATION_FAMILIES = Object.freeze([
  ["platform", registerPlatformTools],
  ["issues", registerIssueTools],
  ["merge_requests", registerMergeRequestTools],
  ["repository", registerRepositoryTools],
  ["pipelines", registerPipelineTools],
  ["governance", registerGovernanceTools],
  ["releases", registerReleaseTools],
  ["pipeline_schedules", registerPipelineScheduleTools],
  ["ci_variables", registerCiVariableTools],
  ["deployments", registerDeploymentTools],
  ["webhooks", registerWebhookTools],
]);

function stableStringCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(stableStringCompare)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function serializedBytes(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function estimateTokens(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(
      "Schema byte count must be a non-negative safe integer.",
    );
  }
  return Math.ceil(bytes / TOKEN_ESTIMATOR.bytesPerEstimatedToken);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function listCanonicalTools({ readOnly }) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    readOnly,
    clientFactory: () => {
      throw new Error("Surface auditing must not call GitLab.");
    },
  });
  const client = new Client({ name: "surface-audit", version: "1.0.0" });

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function normalizeRegistrationFamily(family) {
  if (typeof family !== "string" || !/^[a-z][a-z0-9_]*$/.test(family)) {
    throw new TypeError(
      "GitLab MCP registration family must be a stable snake_case identifier.",
    );
  }
  return family;
}

function auditToolRegistrar({
  family,
  readOnly,
  registeredToolNames,
  metadata,
}) {
  const normalizedFamily = normalizeRegistrationFamily(family);
  return (name, config) => {
    const annotations = config.annotations;
    if (typeof annotations?.readOnlyHint !== "boolean") {
      throw new TypeError(
        `GitLab MCP tool ${name} must declare a readOnlyHint annotation.`,
      );
    }
    if (readOnly && !annotations.readOnlyHint) return;
    registeredToolNames.push(name);
    metadata.push({
      name,
      family: normalizedFamily,
      access: annotations.readOnlyHint ? "read" : "write",
      destructive: annotations.destructiveHint === true,
      safetyAnnotationsComplete:
        typeof annotations.destructiveHint === "boolean" &&
        typeof annotations.idempotentHint === "boolean" &&
        typeof annotations.openWorldHint === "boolean",
    });
  };
}

function collectRegistrationMetadata({ readOnly }) {
  const registeredToolNames = [];
  const metadata = [];
  const registrar = (family) =>
    auditToolRegistrar({ family, readOnly, registeredToolNames, metadata });

  registerRuntimeTools(registrar("runtime"), {
    registeredToolNames,
    readOnly,
    deploymentMode: "embedded",
  });
  for (const [family, registerFamily] of AUDIT_REGISTRATION_FAMILIES) {
    registerFamily(registrar(family));
  }
  return metadata;
}

function visibleSafetyClassification(tool) {
  const annotations = tool.annotations;
  if (
    typeof annotations?.readOnlyHint !== "boolean" ||
    typeof annotations.destructiveHint !== "boolean" ||
    typeof annotations.idempotentHint !== "boolean" ||
    typeof annotations.openWorldHint !== "boolean"
  ) {
    throw new TypeError(
      `Tool ${tool.name} has incomplete MCP-visible safety annotations.`,
    );
  }
  return {
    access: annotations.readOnlyHint ? "read" : "write",
    destructive: annotations.destructiveHint,
  };
}

function assertRegistrationMetadata(tools, metadata) {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const metadataNames = new Set(metadata.map((entry) => entry.name));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  if (toolNames.size !== tools.length) {
    throw new Error("Canonical MCP surface contains duplicate tool names.");
  }
  if (metadataNames.size !== metadata.length) {
    throw new Error(
      "Tool registration metadata contains duplicate tool names.",
    );
  }
  if (toolNames.size !== metadataNames.size) {
    throw new Error(
      `Tool metadata count ${metadataNames.size} does not match MCP surface count ${toolNames.size}.`,
    );
  }
  for (const name of toolNames) {
    if (!metadataNames.has(name)) {
      throw new Error(`Tool ${name} is missing registration metadata.`);
    }
  }
  for (const entry of metadata) {
    if (entry.family === "unclassified") {
      throw new Error(`Tool ${entry.name} has no stable registration family.`);
    }
    if (!entry.safetyAnnotationsComplete) {
      throw new Error(
        `Tool ${entry.name} has incomplete registration safety annotations.`,
      );
    }
    const visible = visibleSafetyClassification(toolsByName.get(entry.name));
    if (
      entry.access !== visible.access ||
      entry.destructive !== visible.destructive
    ) {
      throw new Error(
        `Tool ${entry.name} registration metadata does not match MCP-visible safety annotations.`,
      );
    }
  }
}

function summarizeEntries(entries) {
  const definitions = entries.map((entry) => entry.definition);
  const serialized = serializedBytes(definitions);
  return {
    toolCount: entries.length,
    readToolCount: entries.filter((entry) => entry.access === "read").length,
    writeToolCount: entries.filter((entry) => entry.access === "write").length,
    destructiveToolCount: entries.filter((entry) => entry.destructive).length,
    serializedSchemaBytes: serialized,
    sumToolSchemaBytes: entries.reduce(
      (total, entry) => total + entry.schemaBytes,
      0,
    ),
    estimatedSchemaTokens: estimateTokens(serialized),
    definitionFingerprint: sha256(canonicalJson(definitions)),
  };
}

export function measureSurface(tools, metadata, { mode }) {
  assertRegistrationMetadata(tools, metadata);
  const metadataByName = new Map(metadata.map((entry) => [entry.name, entry]));
  const entries = [...tools]
    .sort((left, right) => stableStringCompare(left.name, right.name))
    .map((definition) => {
      const registration = metadataByName.get(definition.name);
      const schemaBytes = serializedBytes(definition);
      return {
        name: definition.name,
        family: registration.family,
        access: registration.access,
        destructive: registration.destructive,
        schemaBytes,
        estimatedSchemaTokens: estimateTokens(schemaBytes),
        definition,
      };
    });

  const families = [...new Set(entries.map((entry) => entry.family))]
    .sort(stableStringCompare)
    .map((family) => {
      const familyEntries = entries.filter((entry) => entry.family === family);
      return { family, ...summarizeEntries(familyEntries) };
    });

  const largestTools = [...entries]
    .sort(
      (left, right) =>
        right.schemaBytes - left.schemaBytes ||
        stableStringCompare(left.name, right.name),
    )
    .slice(0, 10)
    .map(({ name, family, schemaBytes, estimatedSchemaTokens }) => ({
      name,
      family,
      schemaBytes,
      estimatedSchemaTokens,
    }));

  return {
    mode,
    ...summarizeEntries(entries),
    families,
    largestTools,
    tools: entries.map(
      ({
        name,
        family,
        access,
        destructive,
        schemaBytes,
        estimatedSchemaTokens,
      }) => ({
        name,
        family,
        access,
        destructive,
        schemaBytes,
        estimatedSchemaTokens,
      }),
    ),
  };
}

export async function auditCanonicalSurfaces() {
  const fullTools = await listCanonicalTools({ readOnly: false });
  const readOnlyTools = await listCanonicalTools({ readOnly: true });
  const fullMetadata = collectRegistrationMetadata({ readOnly: false });
  const readOnlyMetadata = collectRegistrationMetadata({ readOnly: true });

  return {
    all: measureSurface(fullTools, fullMetadata, { mode: "all" }),
    readOnly: measureSurface(readOnlyTools, readOnlyMetadata, {
      mode: "read_only",
    }),
  };
}

export function compactSurfaceBaseline(surface) {
  const compact = { ...surface };
  delete compact.tools;
  return compact;
}

function validateBaselineSource(source) {
  if (
    typeof source?.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(source.commit)
  ) {
    throw new TypeError(
      "Baseline source commit must be a full 40-character hexadecimal Git SHA.",
    );
  }
  if (
    typeof source.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(source.capturedAt)
  ) {
    throw new TypeError("Baseline capture date must use YYYY-MM-DD.");
  }
  const date = new Date(`${source.capturedAt}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== source.capturedAt
  ) {
    throw new TypeError("Baseline capture date must be a real calendar date.");
  }
}

export function buildBaselineDocument({ source, surfaces }) {
  validateBaselineSource(source);
  if (!surfaces?.all || !surfaces?.readOnly) {
    throw new TypeError(
      "Full and read-only surface measurements are required.",
    );
  }
  return {
    schemaVersion: SURFACE_BASELINE_SCHEMA_VERSION,
    classification: "benchmark",
    baseline: "pre_toolset_all_surface",
    source,
    tokenEstimator: TOKEN_ESTIMATOR,
    surfaces: {
      all: compactSurfaceBaseline(surfaces.all),
      readOnly: compactSurfaceBaseline(surfaces.readOnly),
    },
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateReferenceRegistryShape(registry) {
  if (
    registry?.schemaVersion !== 1 ||
    registry.classification !== "reference" ||
    !Array.isArray(registry.references)
  ) {
    throw new TypeError(
      "Reference registry must use schemaVersion 1, classification reference, and references[].",
    );
  }
}

function validateReferenceIdentity(reference, ids) {
  if (!nonEmptyString(reference.id) || ids.has(reference.id)) {
    throw new TypeError("Reference registry IDs must be present and unique.");
  }
  ids.add(reference.id);
  if (reference.classification !== "reference") {
    throw new TypeError(
      `Reference ${reference.id} must be classified as reference.`,
    );
  }
}

function validateReferenceFields(reference) {
  for (const field of ["project", "snapshot", "methodology", "caveats"]) {
    if (!nonEmptyString(reference[field])) {
      throw new TypeError(`Reference ${reference.id} is missing ${field}.`);
    }
  }
  if (
    !reference.provenance ||
    typeof reference.provenance !== "object" ||
    Array.isArray(reference.provenance)
  ) {
    throw new TypeError(`Reference ${reference.id} is missing provenance.`);
  }
  if (
    !nonEmptyString(reference.provenance.kind) ||
    ![reference.provenance.source, reference.provenance.path].some(
      nonEmptyString,
    )
  ) {
    throw new TypeError(
      `Reference ${reference.id} provenance must include kind and source or path.`,
    );
  }
  if (
    !Array.isArray(reference.measurements) ||
    reference.measurements.length === 0
  ) {
    throw new TypeError(`Reference ${reference.id} must contain measurements.`);
  }
}

function validateReferenceMeasurement(referenceId, measurement) {
  if (
    !nonEmptyString(measurement.metric) ||
    !Number.isFinite(measurement.value) ||
    !nonEmptyString(measurement.unit)
  ) {
    throw new TypeError(
      `Reference ${referenceId} has an incomplete measurement.`,
    );
  }
}

function validateReference(reference, ids) {
  validateReferenceIdentity(reference, ids);
  validateReferenceFields(reference);
  for (const measurement of reference.measurements) {
    validateReferenceMeasurement(reference.id, measurement);
  }
}

export function validateReferenceRegistry(registry) {
  validateReferenceRegistryShape(registry);
  const ids = new Set();
  for (const reference of registry.references) {
    validateReference(reference, ids);
  }
  return true;
}
