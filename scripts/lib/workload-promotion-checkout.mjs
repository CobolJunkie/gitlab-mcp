function fullCommitSha(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  const invalidCharacter = [...normalized].some(
    (character) => !"0123456789abcdef".includes(character),
  );
  if (normalized.length !== 40 || invalidCharacter) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return normalized;
}

function assertCleanCheckoutProvenance({
  expectedCommitSha,
  checkoutCommitSha,
  trackedChanges,
  operation,
  expectedLabel,
}) {
  const expectedSha = fullCommitSha(expectedCommitSha, expectedLabel);
  const checkoutSha = fullCommitSha(checkoutCommitSha, "checkout HEAD SHA");
  if (expectedSha !== checkoutSha) {
    throw new Error(
      `${operation} requires checkout HEAD to match ${expectedLabel} exactly.`,
    );
  }
  if (typeof trackedChanges !== "string") {
    throw new TypeError("trackedChanges must be a string.");
  }
  if (trackedChanges.trim() !== "") {
    throw new Error(
      `${operation} requires a clean tracked checkout matching ${expectedLabel}.`,
    );
  }
  return true;
}

export function assertPromotionCheckoutProvenance({
  reportCommitSha,
  checkoutCommitSha,
  trackedChanges,
}) {
  return assertCleanCheckoutProvenance({
    expectedCommitSha: reportCommitSha,
    checkoutCommitSha,
    trackedChanges,
    operation: "Baseline promotion",
    expectedLabel: "the benchmark report commit",
  });
}

export function assertLiveBenchmarkCheckoutProvenance({
  benchmarkCommitSha,
  checkoutCommitSha,
  trackedChanges,
}) {
  return assertCleanCheckoutProvenance({
    expectedCommitSha: benchmarkCommitSha,
    checkoutCommitSha,
    trackedChanges,
    operation: "Live workload benchmarking",
    expectedLabel: "the attributed benchmark commit",
  });
}
