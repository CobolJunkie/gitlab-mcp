import { readFile, writeFile } from "node:fs/promises";

import { buildCurrentSurfaceSnapshot } from "./lib/current-surface-snapshot.mjs";
import {
  APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  assertApprovedPostBaselineAdditions,
  assertPreToolsetBaselineContent,
  assertPreToolsetBaselineRewrite,
  assertPreToolsetMembership,
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
import {
  auditCanonicalToolsetSurfaces,
  auditToolsetSurface,
} from "./lib/toolset-surface-audit.mjs";

const baselineUrl = new URL(
  "../benchmarks/surface-baseline.json",
  import.meta.url,
);
const currentSurfaceUrl = new URL(
  "../benchmarks/surface-current.json",
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

function requiredSnapshotSource() {
  const sourceCommit = optionValue("--source-commit=");
  const capturedAt = optionValue("--captured-at=");
  if (!sourceCommit || !capturedAt) {
    throw new Error(
      "Snapshot writes require --source-commit=<sha> and --captured-at=<YYYY-MM-DD>.",
    );
  }
  return { commit: sourceCommit, capturedAt };
}

const write = process.argv.includes("--write");
const writeCurrent = process.argv.includes("--write-current");
const check = process.argv.includes("--check");
const candidateToolsets = optionValue("--toolsets=");
const candidateReadOnly = process.argv.includes("--read-only");
if ([write, writeCurrent, check].filter(Boolean).length > 1) {
  throw new Error("Choose one of --write, --write-current, or --check.");
}
if (candidateToolsets !== undefined && (write || writeCurrent || check)) {
  throw new Error(
    "--toolsets cannot be combined with --write, --write-current, or --check.",
  );
}
if (candidateReadOnly && candidateToolsets === undefined) {
  throw new Error("--read-only requires --toolsets=<selection>.");
}

const references = JSON.parse(await readFile(referencesUrl, "utf8"));
validateReferenceRegistry(references);

if (candidateToolsets !== undefined) {
  const surface = await auditToolsetSurface(candidateToolsets, {
    readOnly: candidateReadOnly,
  });
  console.log(
    JSON.stringify(
      {
        schemaVersion: SURFACE_BASELINE_SCHEMA_VERSION,
        classification: "benchmark",
        tokenEstimator: TOKEN_ESTIMATOR,
        candidate: surface,
      },
      null,
      2,
    ),
  );
} else {
  const surfaces = await auditCanonicalSurfaces();
  const historicalSurfaces = await auditCanonicalSurfaces({
    excludeToolNames: APPROVED_POST_BASELINE_TOOL_ADDITIONS,
  });
  assertPreToolsetMembership(historicalSurfaces);
  assertApprovedPostBaselineAdditions(surfaces, historicalSurfaces);

  if (write) {
    const source = requiredSnapshotSource();
    assertPreToolsetBaselineSource(source);
    const document = buildBaselineDocument({
      source,
      surfaces: historicalSurfaces,
    });
    const existing = JSON.parse(await readFile(baselineUrl, "utf8"));
    assertPreToolsetBaselineRewrite(existing, document);
    await writeFile(
      baselineUrl,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote ${baselineUrl.pathname}`);
  } else if (writeCurrent) {
    const document = buildCurrentSurfaceSnapshot({
      source: requiredSnapshotSource(),
      surfaces,
    });
    await writeFile(
      currentSurfaceUrl,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote ${currentSurfaceUrl.pathname}`);
  } else if (check) {
    const historicalContent = await readFile(baselineUrl, "utf8");
    assertPreToolsetBaselineContent(historicalContent);
    const historicalExpected = JSON.parse(historicalContent);
    assertPreToolsetBaselineSource(historicalExpected.source);

    const currentExpected = JSON.parse(
      await readFile(currentSurfaceUrl, "utf8"),
    );
    const currentActual = buildCurrentSurfaceSnapshot({
      source: currentExpected.source,
      surfaces,
    });
    if (canonicalJson(currentExpected) !== canonicalJson(currentActual)) {
      console.error(
        "Committed current surface snapshot is stale. Generated snapshot follows:",
      );
      console.error(JSON.stringify(currentActual, null, 2));
      process.exitCode = 1;
    }

    if (process.exitCode !== 1) {
      console.log(
        `Surface contracts are current: ${historicalExpected.surfaces.all.toolCount} frozen historical full tools / ${historicalExpected.surfaces.readOnly.toolCount} frozen historical read-only tools; ${currentActual.surfaces.all.toolCount} current full tools / ${currentActual.surfaces.readOnly.toolCount} current read-only tools.`,
      );
    }
  } else {
    const toolsets = await auditCanonicalToolsetSurfaces();
    console.log(
      JSON.stringify(
        {
          schemaVersion: SURFACE_BASELINE_SCHEMA_VERSION,
          classification: "benchmark",
          tokenEstimator: TOKEN_ESTIMATOR,
          surfaces,
          historicalPreToolsetProjection: historicalSurfaces,
          approvedPostBaselineToolAdditions:
            APPROVED_POST_BASELINE_TOOL_ADDITIONS,
          toolsets,
        },
        null,
        2,
      ),
    );
  }
}
