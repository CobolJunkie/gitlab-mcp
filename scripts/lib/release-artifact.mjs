export const RELEASE_ARTIFACT_LABEL_MAX_LENGTH = 128;

const RELEASE_ARTIFACT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

export function resolveReleaseArtifactLabel({
  releaseTag,
  configuredLabel,
  fallback = "validation",
} = {}) {
  const label = releaseTag || configuredLabel || fallback;
  if (typeof label !== "string") {
    throw new TypeError("Release artifact label must be a string.");
  }
  if (
    label.length > RELEASE_ARTIFACT_LABEL_MAX_LENGTH ||
    !RELEASE_ARTIFACT_LABEL_PATTERN.test(label)
  ) {
    throw new Error(
      `Release artifact label must be 1-${RELEASE_ARTIFACT_LABEL_MAX_LENGTH} filename-safe ASCII characters: letters, numbers, dot, underscore, plus, or hyphen, starting with a letter or number.`,
    );
  }
  return label;
}
