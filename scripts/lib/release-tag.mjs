export function expectedReleaseTag(canonicalVersion) {
  return `v${canonicalVersion}`;
}

export function assertReleaseTagMatchesCanonical(tag, canonicalVersion) {
  const expectedTag = expectedReleaseTag(canonicalVersion);
  if (tag !== expectedTag) {
    throw new Error(
      `Release tag must exactly match canonical distribution version ${expectedTag}; received ${tag || "<empty>"}.`,
    );
  }
}
