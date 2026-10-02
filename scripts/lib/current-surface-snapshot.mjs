function validateSource(source) {
  if (
    typeof source?.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(source.commit)
  ) {
    throw new TypeError(
      "Current surface source commit must be a full 40-character hexadecimal Git SHA.",
    );
  }
  if (
    typeof source.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(source.capturedAt)
  ) {
    throw new TypeError("Current surface capture date must use YYYY-MM-DD.");
  }
  const date = new Date(`${source.capturedAt}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== source.capturedAt
  ) {
    throw new TypeError(
      "Current surface capture date must be a real calendar date.",
    );
  }
}

function familyContract(family) {
  return {
    family: family.family,
    toolCount: family.toolCount,
    readToolCount: family.readToolCount,
    writeToolCount: family.writeToolCount,
    destructiveToolCount: family.destructiveToolCount,
  };
}

function surfaceContract(surface) {
  return {
    mode: surface.mode,
    toolCount: surface.toolCount,
    readToolCount: surface.readToolCount,
    writeToolCount: surface.writeToolCount,
    destructiveToolCount: surface.destructiveToolCount,
    serializedSchemaBytes: surface.serializedSchemaBytes,
    sumToolSchemaBytes: surface.sumToolSchemaBytes,
    estimatedSchemaTokens: surface.estimatedSchemaTokens,
    definitionFingerprint: surface.definitionFingerprint,
    families: surface.families.map(familyContract),
  };
}

export function buildCurrentSurfaceSnapshot({ source, surfaces }) {
  validateSource(source);
  if (!surfaces?.all || !surfaces?.readOnly) {
    throw new TypeError(
      "Full and read-only surface measurements are required for the current snapshot.",
    );
  }
  return {
    schemaVersion: 1,
    classification: "benchmark",
    snapshot: "current_all_surface",
    source,
    surfaces: {
      all: surfaceContract(surfaces.all),
      readOnly: surfaceContract(surfaces.readOnly),
    },
  };
}
