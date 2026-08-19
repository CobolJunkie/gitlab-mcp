import assert from "node:assert/strict";

const SHA256_HEX_CHARACTERS = "0123456789abcdefABCDEF";

function isSha256Digest(value) {
  if (value.length !== 64) {
    return false;
  }
  for (const character of value) {
    if (!SHA256_HEX_CHARACTERS.includes(character)) {
      return false;
    }
  }
  return true;
}

function parseChecksumLine(line) {
  const normalized = line.trim();
  const sha256 = normalized.slice(0, 64);
  if (!isSha256Digest(sha256)) {
    return null;
  }

  const separator = normalized[64];
  if (separator !== " " && separator !== "\t") {
    return null;
  }

  let archive = normalized.slice(65).trimStart();
  if (archive.startsWith("*")) {
    archive = archive.slice(1);
  }
  if (!archive) {
    return null;
  }
  return { archive, sha256 };
}

export function parseArchiveChecksum(text, archiveName, checksumFile) {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError(`${checksumFile} must contain a checksum.`);
  }

  const matches = text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .map(parseChecksumLine)
    .filter((entry) => entry?.archive === archiveName);

  if (matches.length !== 1) {
    throw new Error(
      `${checksumFile} must contain exactly one SHA-256 entry for ${archiveName}.`,
    );
  }
  return matches[0].sha256.toLowerCase();
}

export function assertCompleteHarnessSet(summaries, supportedHarnesses) {
  const actualIds = summaries.map((summary) => summary.id);
  const expectedIds = supportedHarnesses.map((harness) => harness.id);
  assert.deepEqual(
    actualIds,
    expectedIds,
    "Cross-harness release must contain every supported harness exactly once and in canonical order.",
  );

  assert.equal(
    new Set(actualIds).size,
    actualIds.length,
    "Cross-harness release harness IDs must be unique.",
  );
  assert.equal(
    new Set(supportedHarnesses.map((harness) => harness.artifactName)).size,
    supportedHarnesses.length,
    "Supported harness artifact names must be unique.",
  );
}

export function expectedReleaseDirectoryEntries(
  supportedHarnesses,
  releaseLabel,
) {
  const codexHarnesses = supportedHarnesses.filter(
    (harness) => harness.id === "codex",
  );
  assert.equal(
    codexHarnesses.length,
    1,
    "Supported harnesses must contain exactly one Codex distribution.",
  );

  const [codex] = codexHarnesses;
  const entries = [
    {
      name: `${codex.artifactName}-${releaseLabel}.tar.gz`,
      type: "file",
    },
    {
      name: `${codex.artifactName}-${releaseLabel}.cdx.json`,
      type: "file",
    },
    { name: "SHA256SUMS", type: "file" },
  ];

  for (const harness of supportedHarnesses) {
    if (harness.id === "codex") {
      continue;
    }
    const archiveName = `${harness.artifactName}-${releaseLabel}.tar.gz`;
    entries.push(
      { name: harness.artifactName, type: "directory" },
      { name: archiveName, type: "file" },
      { name: `${archiveName}.sha256`, type: "file" },
    );
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export function assertCompleteReleaseDirectory(
  actualEntries,
  supportedHarnesses,
  releaseLabel,
) {
  const normalizedActual = actualEntries
    .map(({ name, type }) => ({ name, type }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(
    normalizedActual,
    expectedReleaseDirectoryEntries(supportedHarnesses, releaseLabel),
    "Release output must contain exactly the expected current harness artifacts before the aggregate manifest is written.",
  );
}

export function buildCrossHarnessManifest({
  canonical,
  canonicalBundle,
  canonicalSkills,
  harnesses,
}) {
  return {
    schemaVersion: 1,
    distribution: {
      name: canonical.name,
      version: canonical.version,
    },
    canonicalBundle,
    canonicalSkills,
    harnesses: harnesses.map((harness) => ({
      id: harness.id,
      label: harness.label,
      artifactName: harness.artifactName,
      archive: harness.archive,
      archiveBytes: harness.archiveBytes,
      packageBytes: harness.packageBytes,
      sha256: harness.sha256,
      checksumFile: harness.checksumFile,
      bundleSha256: harness.bundleSha256,
      skillsSha256: harness.skillsSha256,
    })),
  };
}
