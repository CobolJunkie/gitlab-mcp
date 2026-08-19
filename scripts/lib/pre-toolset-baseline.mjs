import { canonicalJson } from "./surface-audit.mjs";

export const PRE_TOOLSET_BASELINE_SOURCE = Object.freeze({
  commit: "b93e1df69e9515d868e66da9c0c420562d90303b",
  capturedAt: "2026-08-17",
});

export function assertPreToolsetBaselineSource(source) {
  const keys =
    source && typeof source === "object" && !Array.isArray(source)
      ? Object.keys(source)
      : [];
  if (
    keys.length !== 2 ||
    source.commit !== PRE_TOOLSET_BASELINE_SOURCE.commit ||
    source.capturedAt !== PRE_TOOLSET_BASELINE_SOURCE.capturedAt
  ) {
    throw new Error(
      `Pre-toolset baseline provenance must remain pinned to ${PRE_TOOLSET_BASELINE_SOURCE.commit} captured ${PRE_TOOLSET_BASELINE_SOURCE.capturedAt}.`,
    );
  }
  return true;
}

export function assertPreToolsetBaselineRewrite(existing, proposed) {
  assertPreToolsetBaselineSource(existing?.source);
  assertPreToolsetBaselineSource(proposed?.source);
  if (canonicalJson(existing) !== canonicalJson(proposed)) {
    throw new Error(
      "The frozen pre-toolset baseline already exists and must not be overwritten by a different surface. Create a new benchmark snapshot instead.",
    );
  }
  return true;
}
