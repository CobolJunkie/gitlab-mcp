import { createHash } from "node:crypto";

import { canonicalJson } from "./surface-audit.mjs";

export const PRE_TOOLSET_BASELINE_SOURCE = Object.freeze({
  commit: "b93e1df69e9515d868e66da9c0c420562d90303b",
  capturedAt: "2026-08-17",
});

export const PRE_TOOLSET_BASELINE_CONTENT_SHA256 =
  "dc959a06697b7b827cd911b154dffdf029b06b6cc81b652c198841df0cc512e5";

// Derived from the sorted tool-name sets in docs/gitlab-tool-contracts.json at
// PRE_TOOLSET_BASELINE_SOURCE.commit. These fingerprints preserve historical
// membership without freezing schemas for tools whose contracts legitimately evolve.
export const PRE_TOOLSET_BASELINE_TOOL_NAMES_SHA256 =
  "623049d90499f4f9ff1c79b9fa485a4033089d7164179b375341e2b897390ffe";
export const PRE_TOOLSET_BASELINE_READ_ONLY_TOOL_NAMES_SHA256 =
  "cdb03f893778427714d2a6560ca9c96223620665820674fd6a71a2ddb22c1176";

export function assertPreToolsetBaselineContent(content) {
  if (typeof content !== "string") {
    throw new TypeError("Frozen pre-toolset baseline content must be text.");
  }
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== PRE_TOOLSET_BASELINE_CONTENT_SHA256) {
    throw new Error(
      "The frozen pre-toolset baseline must remain byte-for-byte identical to the reviewed historical artifact.",
    );
  }
  return true;
}

export const APPROVED_POST_BASELINE_TOOL_ADDITIONS = Object.freeze([
  "apply_repository_hunks",
  "cherry_pick_commit",
  "commit_job_artifact_file",
  "create_group_label",
  "create_group_milestone",
  "create_project_access_token",
  "create_project_label",
  "create_project_milestone",
  "delete_group_label",
  "delete_group_milestone",
  "delete_project_label",
  "delete_project_milestone",
  "get_group_label",
  "get_project_label",
  "delete_environment",
  "get_project_access_token",
  "get_project_access_token_capabilities",
  "list_project_access_tokens",
  "replace_project_access_token_ci_credential",
  "revert_commit",
  "revoke_project_access_token",
  "rotate_project_access_token",
  "stop_environment",
  "update_group_label",
  "update_group_milestone",
  "update_project_label",
  "update_project_milestone",
  "list_group_labels",
]);

export const APPROVED_POST_BASELINE_READ_ONLY_TOOL_ADDITIONS = Object.freeze([
  "get_group_label",
  "get_project_access_token",
  "get_project_label",
  "list_group_labels",
  "get_project_access_token_capabilities",
  "list_project_access_tokens",
]);

function toolNames(surface) {
  if (!Array.isArray(surface?.tools)) {
    throw new TypeError("Surface comparison requires detailed tool entries.");
  }
  const names = surface.tools
    .map((tool) => {
      if (typeof tool?.name !== "string" || !tool.name.trim()) {
        throw new TypeError(
          "Surface comparison requires non-empty tool names.",
        );
      }
      return tool.name;
    })
    .sort((left, right) => left.localeCompare(right));
  if (new Set(names).size !== names.length) {
    throw new TypeError("Surface comparison requires unique tool names.");
  }
  return names;
}

function toolNameDigest(surface) {
  return createHash("sha256")
    .update(canonicalJson(toolNames(surface)), "utf8")
    .digest("hex");
}

export function assertPreToolsetMembership(historical) {
  const allDigest = toolNameDigest(historical?.all);
  const readOnlyDigest = toolNameDigest(historical?.readOnly);
  if (
    allDigest !== PRE_TOOLSET_BASELINE_TOOL_NAMES_SHA256 ||
    readOnlyDigest !== PRE_TOOLSET_BASELINE_READ_ONLY_TOOL_NAMES_SHA256
  ) {
    throw new Error(
      `Pre-toolset tool membership must match the frozen contract snapshot at ${PRE_TOOLSET_BASELINE_SOURCE.commit}.`,
    );
  }
  return true;
}

function assertExactAdditions(currentNames, historicalNames, approved, label) {
  const historical = new Set(historicalNames);
  const current = new Set(currentNames);
  const added = currentNames.filter((name) => !historical.has(name));
  const removed = historicalNames.filter((name) => !current.has(name));
  if (
    canonicalJson(added) !==
      canonicalJson(
        [...approved].sort((left, right) => left.localeCompare(right)),
      ) ||
    removed.length > 0
  ) {
    throw new Error(
      `${label} must differ from the frozen pre-toolset projection only by approved additions: ${approved.join(", ")}.`,
    );
  }
}

export function assertApprovedPostBaselineAdditions(current, historical) {
  assertExactAdditions(
    toolNames(current?.all),
    toolNames(historical?.all),
    APPROVED_POST_BASELINE_TOOL_ADDITIONS,
    "Current MCP surface",
  );
  assertExactAdditions(
    toolNames(current?.readOnly),
    toolNames(historical?.readOnly),
    APPROVED_POST_BASELINE_READ_ONLY_TOOL_ADDITIONS,
    "Current read-only MCP surface",
  );
  return true;
}

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
