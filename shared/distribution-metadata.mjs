const DISTRIBUTION_METADATA_KEY = Symbol.for(
  "@local/gitlab-mcp/distribution-metadata",
);

export function normalizeDistributionMetadata(metadata) {
  const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
  const version =
    typeof metadata?.version === "string" ? metadata.version.trim() : "";

  if (!name || !version) {
    throw new TypeError(
      "Distribution metadata requires non-empty name and version strings.",
    );
  }

  return Object.freeze({ name, version });
}

export function getDistributionMetadata() {
  return globalThis[DISTRIBUTION_METADATA_KEY];
}

export function resolveDistributionMetadata(options = {}) {
  if (
    !Object.hasOwn(options, "distributionMetadata") ||
    options.distributionMetadata === undefined
  ) {
    return getDistributionMetadata();
  }
  if (options.distributionMetadata === null) {
    return null;
  }
  return normalizeDistributionMetadata(options.distributionMetadata);
}

export function setDistributionMetadata(metadata) {
  const normalized = normalizeDistributionMetadata(metadata);
  const current = getDistributionMetadata();
  if (current) {
    if (
      current.name !== normalized.name ||
      current.version !== normalized.version
    ) {
      throw new Error("Distribution metadata is already configured.");
    }
    return current;
  }

  Object.defineProperty(globalThis, DISTRIBUTION_METADATA_KEY, {
    value: normalized,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return normalized;
}
