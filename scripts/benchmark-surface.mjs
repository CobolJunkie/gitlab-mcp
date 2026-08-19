import { readFile, writeFile } from "node:fs/promises";

import {
  assertPreToolsetBaselineRewrite,
  assertPreToolsetBaselineSource,
} from "./lib/pre-toolset-baseline.mjs";
import {
  auditCanonicalSurfaces,
  buildBaselineDocument,
  canonicalJson,
  SURFACE_BASELINE_SCHEMA_VERSION,
  TOKEN_ESTIMATOR,
  validateReferenceRegistry,
} from "./lib/surface-audit.mjs";

const baselineUrl = new URL(
  "../benchmarks/surface-baseline.json",
  import.meta.url,
);
const referencesUrl = new URL(
  "../benchmarks/external-references.json",
  import.meta.url,
);

function optionValue(prefix) {
  const argument = process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check");
if (write && check) {
  throw new Error("Choose either --write or --check, not both.");
}

const references = JSON.parse(await readFile(referencesUrl, "utf8"));
validateReferenceRegistry(references);
const surfaces = await auditCanonicalSurfaces();

if (write) {
  const sourceCommit = optionValue("--source-commit=");
  const capturedAt = optionValue("--captured-at=");
  if (!sourceCommit || !capturedAt) {
    throw new Error(
      "--write requires --source-commit=<sha> and --captured-at=<YYYY-MM-DD>.",
    );
  }
  const source = { commit: sourceCommit, capturedAt };
  assertPreToolsetBaselineSource(source);
  const document = buildBaselineDocument({ source, surfaces });
  const existing = JSON.parse(await readFile(baselineUrl, "utf8"));
  assertPreToolsetBaselineRewrite(existing, document);

  await writeFile(
    baselineUrl,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${baselineUrl.pathname}`);
} else if (check) {
  const expected = JSON.parse(await readFile(baselineUrl, "utf8"));
  assertPreToolsetBaselineSource(expected.source);
  const actual = buildBaselineDocument({ source: expected.source, surfaces });
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    console.error(
      "Committed surface baseline is stale. Generated baseline follows:",
    );
    console.error(JSON.stringify(actual, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      `Surface baseline is current: ${actual.surfaces.all.toolCount} full tools, ${actual.surfaces.readOnly.toolCount} read-only tools.`,
    );
  }
} else {
  console.log(
    JSON.stringify(
      {
        schemaVersion: SURFACE_BASELINE_SCHEMA_VERSION,
        classification: "benchmark",
        tokenEstimator: TOKEN_ESTIMATOR,
        surfaces,
      },
      null,
      2,
    ),
  );
}
