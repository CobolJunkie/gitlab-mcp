import { metrics } from "@opentelemetry/api";

import contractDocument from "./gitlab-metric-contract.json" with { type: "json" };

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const METRIC_NAME_PREFIX = "gitlab_mcp.";
const METRIC_NAME_PUNCTUATION = new Set([".", "_", "-"]);
const INSTRUMENTATION_NAME = "@local/gitlab-mcp/custom-metrics";
const SAFE_PRIVACY_CLASSIFICATIONS = new Set(["non-sensitive"]);
const SAFE_STABILITY_STATUSES = new Set(["experimental"]);
const SAFE_IDENTIFIER_ATTRIBUTES = new Set(["tool"]);
const SAFE_ATTRIBUTE_ENUM_VALUES = Object.freeze({
  access: new Set(["read", "write"]),
  outcome: new Set([
    "success",
    "error",
    "ready",
    "unavailable",
    "cached",
    "rejected",
  ]),
  error_category: new Set([
    "none",
    "authentication",
    "gitlab_api",
    "timeout",
    "validation",
    "internal",
  ]),
  deployment_mode: new Set(["embedded", "http", "stdio", "unknown"]),
  read_only: new Set(["true", "false"]),
  method: new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT", "OTHER"]),
  status_class: new Set(["2xx", "3xx", "4xx", "5xx", "none"]),
  response_type: new Set(["json", "text", "binary"]),
  reason: new Set([
    "authentication_fallback",
    "host_header",
    "content_type",
    "global_concurrency",
    "body_limit",
    "body_timeout",
    "parse_error",
    "missing_token",
    "token_failure_limit",
    "validation_budget",
    "invalid_token",
    "insufficient_scope",
    "token_validation_unavailable",
    "identity_concurrency",
  ]),
  cache: new Set(["token_validation", "capability"]),
  result: new Set(["hit", "miss"]),
});

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const contract = deepFreeze(contractDocument);
const metricEntries = Object.entries(contract.metrics);
const instruments = new Map();
const cardinality = new Map();
const registeredIdentifiers = new Map();

export const GITLAB_MCP_METRIC_CONTRACT = contract;
export const GITLAB_MCP_METRIC_NAMES = Object.freeze(
  metricEntries.map(([name]) => name),
);

export function metricDefinition(name) {
  return Object.hasOwn(contract.metrics, name)
    ? contract.metrics[name]
    : undefined;
}

function declaredIdentifierAttribute(attribute) {
  return metricEntries.some(
    ([, definition]) =>
      definition.attributes?.[attribute]?.kind === "identifier",
  );
}

export function registerMetricIdentifier(attribute, value) {
  if (!declaredIdentifierAttribute(attribute)) {
    return false;
  }
  const candidate = String(value ?? "");
  if (!SAFE_IDENTIFIER.test(candidate)) {
    return false;
  }
  let values = registeredIdentifiers.get(attribute);
  if (!values) {
    values = new Set();
    registeredIdentifiers.set(attribute, values);
  }
  values.add(candidate);
  return true;
}

function boundedAttribute(name, definition, value) {
  if (definition.values) {
    const candidate = String(value ?? "");
    return definition.values.includes(candidate) ? candidate : undefined;
  }
  if (definition.kind === "identifier") {
    const candidate = String(value ?? "");
    return SAFE_IDENTIFIER.test(candidate) &&
      registeredIdentifiers.get(name)?.has(candidate)
      ? candidate
      : "unknown";
  }
  return undefined;
}

export function sanitizeMetricMeasurement({
  metric,
  value = 1,
  attributes = {},
} = {}) {
  const definition = metricDefinition(metric);
  const numericValue = value;
  if (
    !definition ||
    typeof numericValue !== "number" ||
    !Number.isFinite(numericValue) ||
    (definition.type !== "up_down_counter" && numericValue < 0)
  ) {
    return undefined;
  }

  const sourceAttributes = isObjectRecord(attributes) ? attributes : {};
  const requiredAttributes = new Set(definition.requiredAttributes || []);
  const safeAttributes = {};
  for (const [name, attributeDefinition] of Object.entries(
    definition.attributes || {},
  )) {
    if (!Object.hasOwn(sourceAttributes, name)) {
      if (requiredAttributes.has(name)) {
        return undefined;
      }
      continue;
    }
    const safeValue = boundedAttribute(
      name,
      attributeDefinition,
      sourceAttributes[name],
    );
    if (safeValue === undefined) {
      if (requiredAttributes.has(name)) {
        return undefined;
      }
      continue;
    }
    safeAttributes[name] = safeValue;
  }
  if (
    [...requiredAttributes].some(
      (attribute) => !Object.hasOwn(safeAttributes, attribute),
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    metric,
    value: numericValue,
    attributes: Object.freeze(safeAttributes),
  });
}

function createInstrument(name, definition) {
  const meter = metrics.getMeter(INSTRUMENTATION_NAME);
  const options = {
    unit: definition.unit,
    description: definition.description,
    ...(definition.boundaries
      ? {
          advice: {
            explicitBucketBoundaries: definition.boundaries,
          },
        }
      : undefined),
  };
  if (definition.type === "counter") {
    return meter.createCounter(name, options);
  }
  if (definition.type === "up_down_counter") {
    return meter.createUpDownCounter(name, options);
  }
  return meter.createHistogram(name, options);
}

function attributeFingerprint(attributes) {
  return Object.keys(attributes)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${key}=${attributes[key]}`)
    .join("|");
}

function cardinalityAttributeProfile(attributeDefinition, optional) {
  if (attributeDefinition.kind === "identifier") {
    return { identifier: true, choices: optional ? 2 : 1 };
  }
  if (
    !Array.isArray(attributeDefinition.values) ||
    attributeDefinition.values.length === 0
  ) {
    return undefined;
  }
  return {
    identifier: false,
    choices: attributeDefinition.values.length + (optional ? 1 : 0),
  };
}

function cardinalityProfile(definition) {
  if (
    !Array.isArray(definition.requiredAttributes) ||
    !isObjectRecord(definition.attributes)
  ) {
    return undefined;
  }
  const requiredAttributes = new Set(definition.requiredAttributes);
  let finiteSeries = 1;
  let overflowSeries = 1;
  let hasIdentifier = false;

  for (const [name, attributeDefinition] of Object.entries(
    definition.attributes,
  )) {
    if (!isObjectRecord(attributeDefinition)) {
      return undefined;
    }
    const profile = cardinalityAttributeProfile(
      attributeDefinition,
      !requiredAttributes.has(name),
    );
    if (!profile) {
      return undefined;
    }
    if (profile.identifier) {
      hasIdentifier = true;
      overflowSeries *= profile.choices;
      continue;
    }
    finiteSeries *= profile.choices;
    overflowSeries *= profile.choices;
    if (
      !Number.isSafeInteger(finiteSeries) ||
      !Number.isSafeInteger(overflowSeries)
    ) {
      return undefined;
    }
  }

  return Object.freeze({
    hasIdentifier,
    finiteSeries: hasIdentifier ? undefined : finiteSeries,
    overflowSeries,
  });
}

function collapsedIdentifierAttributes(definition, attributes) {
  const collapsed = { ...attributes };
  for (const [name, attributeDefinition] of Object.entries(
    definition.attributes || {},
  )) {
    if (
      attributeDefinition.kind === "identifier" &&
      Object.hasOwn(collapsed, name)
    ) {
      collapsed[name] = "unknown";
    }
  }
  return Object.freeze(collapsed);
}

export function enforceMetricCardinalityBudget(measurement) {
  const definition = metricDefinition(measurement?.metric);
  if (
    !definition ||
    !measurement?.attributes ||
    typeof measurement.attributes !== "object"
  ) {
    return undefined;
  }

  const profile = cardinalityProfile(definition);
  if (!profile?.hasIdentifier) {
    return measurement.attributes;
  }

  let seen = cardinality.get(measurement.metric);
  if (!seen) {
    seen = new Set();
    cardinality.set(measurement.metric, seen);
  }

  const fingerprint = attributeFingerprint(measurement.attributes);
  if (seen.has(fingerprint)) {
    return measurement.attributes;
  }

  const regularSeriesBudget = Math.max(
    0,
    definition.cardinalityBudget - profile.overflowSeries,
  );
  if (seen.size < regularSeriesBudget) {
    seen.add(fingerprint);
    return measurement.attributes;
  }

  return collapsedIdentifierAttributes(definition, measurement.attributes);
}

export function recordMetricMeasurement(measurement) {
  const safeMeasurement = sanitizeMetricMeasurement(measurement);
  const definition = metricDefinition(safeMeasurement?.metric);
  if (!definition) {
    return;
  }
  let instrument = instruments.get(safeMeasurement.metric);
  if (!instrument) {
    instrument = createInstrument(safeMeasurement.metric, definition);
    instruments.set(safeMeasurement.metric, instrument);
  }
  const attributes = enforceMetricCardinalityBudget(safeMeasurement);
  if (definition.type === "histogram") {
    instrument.record(safeMeasurement.value, attributes);
  } else {
    instrument.add(safeMeasurement.value, attributes);
  }
}

export function resetMetricContractStateForTest() {
  instruments.clear();
  cardinality.clear();
  registeredIdentifiers.clear();
}

function validateRequiredAttributes(name, definition, errors) {
  if (!Array.isArray(definition.requiredAttributes)) {
    errors.push(`${name}: requiredAttributes must be an array.`);
    return;
  }
  const declared = definition.attributes;
  if (!isObjectRecord(declared)) {
    return;
  }
  const seen = new Set();
  for (const attribute of definition.requiredAttributes) {
    if (typeof attribute !== "string" || !Object.hasOwn(declared, attribute)) {
      errors.push(
        `${name}: required attribute ${String(attribute)} is not declared.`,
      );
      continue;
    }
    if (seen.has(attribute)) {
      errors.push(`${name}: required attribute ${attribute} is duplicated.`);
    }
    seen.add(attribute);
  }
}

function validateHistogramBoundaries(name, definition, errors) {
  if (definition.type !== "histogram") {
    if (definition.boundaries !== undefined) {
      errors.push(`${name}: boundaries are supported only for histograms.`);
    }
    return;
  }
  if (
    !Array.isArray(definition.boundaries) ||
    definition.boundaries.length === 0
  ) {
    errors.push(`${name}: histogram boundaries required.`);
    return;
  }
  if (
    definition.boundaries.some(
      (boundary) => typeof boundary !== "number" || !Number.isFinite(boundary),
    ) ||
    definition.boundaries.some(
      (boundary, index) =>
        index > 0 && boundary <= definition.boundaries[index - 1],
    )
  ) {
    errors.push(`${name}: invalid histogram boundaries.`);
  }
}

function validateAttributeDefinition(name, attribute, definition, errors) {
  if (!isObjectRecord(definition)) {
    errors.push(
      `${name}.${attribute}: attribute definition must be an object.`,
    );
    return;
  }
  const reviewedEnumValues = Object.hasOwn(
    SAFE_ATTRIBUTE_ENUM_VALUES,
    attribute,
  )
    ? SAFE_ATTRIBUTE_ENUM_VALUES[attribute]
    : undefined;
  const isReviewedIdentifier = SAFE_IDENTIFIER_ATTRIBUTES.has(attribute);
  if (!reviewedEnumValues && !isReviewedIdentifier) {
    errors.push(`${name}.${attribute}: unsupported metric attribute.`);
    return;
  }
  const hasKind = Object.hasOwn(definition, "kind");
  const hasValues = Object.hasOwn(definition, "values");
  if (!hasKind && !hasValues) {
    errors.push(
      `${name}.${attribute}: attribute must define kind or enum values.`,
    );
    return;
  }
  if (hasKind && hasValues) {
    errors.push(
      `${name}.${attribute}: attribute cannot define both kind and enum values.`,
    );
    return;
  }
  if (hasKind) {
    if (definition.kind !== "identifier" || !isReviewedIdentifier) {
      errors.push(`${name}.${attribute}: unsupported attribute kind.`);
    }
    return;
  }
  if (
    !reviewedEnumValues ||
    !Array.isArray(definition.values) ||
    definition.values.length === 0 ||
    definition.values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        !reviewedEnumValues.has(value),
    ) ||
    new Set(definition.values).size !== definition.values.length
  ) {
    errors.push(`${name}.${attribute}: invalid enum values.`);
  }
}

function validateCardinalityBudget(name, definition, errors) {
  if (
    !Number.isSafeInteger(definition.cardinalityBudget) ||
    definition.cardinalityBudget < 1
  ) {
    return;
  }
  const profile = cardinalityProfile(definition);
  if (!profile) {
    return;
  }
  if (
    profile.hasIdentifier &&
    definition.cardinalityBudget <= profile.overflowSeries
  ) {
    errors.push(
      `${name}: cardinality budget must exceed ${profile.overflowSeries} reserved overflow series.`,
    );
    return;
  }
  if (
    !profile.hasIdentifier &&
    definition.cardinalityBudget < profile.finiteSeries
  ) {
    errors.push(
      `${name}: cardinality budget ${definition.cardinalityBudget} cannot represent all ${profile.finiteSeries} closed-enum series.`,
    );
  }
}

function isLowercaseAsciiLetterOrDigit(character) {
  const code = character.codePointAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function isSafeMetricName(name) {
  const suffix = name.slice(METRIC_NAME_PREFIX.length);
  if (suffix.length === 0 || !isLowercaseAsciiLetterOrDigit(suffix[0])) {
    return false;
  }
  for (let index = 1; index < suffix.length; index += 1) {
    const character = suffix[index];
    if (
      !isLowercaseAsciiLetterOrDigit(character) &&
      !METRIC_NAME_PUNCTUATION.has(character)
    ) {
      return false;
    }
  }
  return true;
}

function validateMetricName(name, errors) {
  if (!name.startsWith(METRIC_NAME_PREFIX)) {
    errors.push(`${name}: invalid metric prefix.`);
  } else if (name.length > 255 || !isSafeMetricName(name)) {
    errors.push(`${name}: invalid metric name.`);
  }
}

function validateMetricMetadata(name, definition, errors) {
  if (!["counter", "up_down_counter", "histogram"].includes(definition.type)) {
    errors.push(`${name}: unsupported instrument type.`);
  }
  if (
    !isNonEmptyString(definition.unit) ||
    !isNonEmptyString(definition.description) ||
    !isNonEmptyString(definition.privacy) ||
    !isNonEmptyString(definition.stability)
  ) {
    errors.push(`${name}: incomplete metadata.`);
  }
  if (
    definition.privacy !== undefined &&
    !SAFE_PRIVACY_CLASSIFICATIONS.has(definition.privacy)
  ) {
    errors.push(`${name}: unsupported privacy classification.`);
  }
  if (
    definition.stability !== undefined &&
    !SAFE_STABILITY_STATUSES.has(definition.stability)
  ) {
    errors.push(`${name}: unsupported stability status.`);
  }
  if (
    !Number.isSafeInteger(definition.cardinalityBudget) ||
    definition.cardinalityBudget < 1
  ) {
    errors.push(`${name}: invalid cardinality budget.`);
  }
  if (!isObjectRecord(definition.attributes)) {
    errors.push(`${name}: attributes must be an object.`);
  }
}

function validateMetricAttributes(name, definition, errors) {
  if (!isObjectRecord(definition.attributes)) {
    return;
  }
  for (const [attribute, attributeDefinition] of Object.entries(
    definition.attributes,
  )) {
    validateAttributeDefinition(name, attribute, attributeDefinition, errors);
  }
}

function validateMetricDefinition(name, definition, errors) {
  if (!isObjectRecord(definition)) {
    errors.push(`${name}: metric definition must be an object.`);
    return;
  }
  validateMetricName(name, errors);
  validateMetricMetadata(name, definition, errors);
  validateHistogramBoundaries(name, definition, errors);
  validateRequiredAttributes(name, definition, errors);
  validateMetricAttributes(name, definition, errors);
  validateCardinalityBudget(name, definition, errors);
}

export function validateMetricContract(document = contract) {
  const errors = [];
  if (
    !isObjectRecord(document) ||
    document.schemaVersion !== 1 ||
    !isObjectRecord(document.metrics) ||
    Object.keys(document.metrics).length === 0
  ) {
    errors.push(
      "Metric contract must declare schemaVersion 1 and a metrics object.",
    );
    return errors;
  }
  if (
    document.stability !== undefined &&
    !SAFE_STABILITY_STATUSES.has(document.stability)
  ) {
    errors.push("Metric contract: unsupported stability status.");
  }

  for (const [name, definition] of Object.entries(document.metrics)) {
    validateMetricDefinition(name, definition, errors);
  }
  return errors;
}
