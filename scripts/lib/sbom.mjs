const JSON_INDENT = 2;

export function normalizeCycloneDxSbom(sbomText) {
  if (typeof sbomText !== "string" || !sbomText.trim()) {
    throw new TypeError("CycloneDX SBOM must be a non-empty JSON string.");
  }

  const sbom = JSON.parse(sbomText);
  if (sbom?.bomFormat !== "CycloneDX") {
    throw new TypeError("SBOM must use the CycloneDX format.");
  }

  delete sbom.serialNumber;
  delete sbom.metadata?.timestamp;
  return `${JSON.stringify(sbom, null, JSON_INDENT)}\n`;
}
