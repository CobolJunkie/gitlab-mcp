import { renderClaudeDistributionFiles } from "../../adapters/claude/distribution.mjs";
import { renderClineDistributionFiles } from "../../adapters/cline/distribution.mjs";
import { renderCodexDistributionFiles } from "../../adapters/codex/distribution.mjs";
import { renderPiDistributionFiles } from "../../adapters/pi/distribution.mjs";
import { normalizeCanonicalDistribution } from "./canonical-distribution.mjs";

export {
  assertCanonicalDistributionResources,
  normalizeCanonicalDistribution,
  resolveRepositoryPath,
} from "./canonical-distribution.mjs";

const JSON_INDENT = 2;

function clone(value) {
  return structuredClone(value);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

export function renderDistributionFiles({
  canonical: canonicalInput,
  packageMetadata: packageInput,
  packageLock: packageLockInput,
  codexManifest: codexManifestInput,
  codexMcpConfig: codexMcpConfigInput,
  appConfig: appConfigInput,
}) {
  const canonical = normalizeCanonicalDistribution(canonicalInput);
  const packageMetadata = clone(packageInput);
  const packageLock = clone(packageLockInput);

  if (
    typeof packageMetadata.name !== "string" ||
    packageMetadata.name.trim() === ""
  ) {
    throw new TypeError("package.json requires a non-empty name.");
  }

  packageMetadata.version = canonical.version;
  packageMetadata.description = canonical.description;
  packageMetadata.license = canonical.license;

  if (!packageLock.packages?.[""]) {
    throw new TypeError("package-lock.json requires a root package entry.");
  }
  packageLock.name = packageMetadata.name;
  packageLock.version = canonical.version;
  packageLock.packages[""].name = packageMetadata.name;
  packageLock.packages[""].version = canonical.version;
  packageLock.packages[""].license = canonical.license;

  return {
    "package.json": serializeJson(packageMetadata),
    "package-lock.json": serializeJson(packageLock),
    ...renderCodexDistributionFiles({
      canonical,
      codexManifest: codexManifestInput,
      codexMcpConfig: codexMcpConfigInput,
      appConfig: appConfigInput,
    }),
    ...renderClineDistributionFiles({ canonical }),
    ...renderClaudeDistributionFiles({ canonical }),
    ...renderPiDistributionFiles({ canonical, packageMetadata }),
  };
}

export function assertDistributionFiles(actualFiles, expectedFiles) {
  const drifted = Object.entries(expectedFiles)
    .filter(([path, expected]) => actualFiles[path] !== expected)
    .map(([path]) => path);

  if (drifted.length > 0) {
    throw new Error(
      `Distribution metadata drift detected in ${drifted.join(", ")}. ` +
        "Run npm run adapters:generate.",
    );
  }
}
