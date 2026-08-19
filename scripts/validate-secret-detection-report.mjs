import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { validateSecretDetectionReport } from "./lib/secret-detection-report-gate.mjs";

export {
  MR_100_HISTORY_FINDINGS,
  validateSecretDetectionReport,
} from "./lib/secret-detection-report-gate.mjs";

function describeFinding(vulnerability) {
  const id = vulnerability?.id ?? "<missing-id>";
  const file = vulnerability?.location?.file ?? "<missing-file>";
  const commit = vulnerability?.location?.commit?.sha ?? "<missing-commit>";
  return `${id} at ${file}@${commit}`;
}

function describeExpectedFinding(finding) {
  return `${finding.id} at ${finding.file}@${finding.commit}`;
}

async function main() {
  const reportPath = process.argv[2] ?? "gl-secret-detection-report.json";
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = validateSecretDetectionReport(report, {
    pipelineSource: process.env.CI_PIPELINE_SOURCE,
    mergeRequestIid: process.env.CI_MERGE_REQUEST_IID,
    projectPath: process.env.CI_PROJECT_PATH,
  });

  let rejected = false;
  if (result.unexpected.length > 0) {
    rejected = true;
    console.error(
      `Secret-detection gate rejected ${result.unexpected.length} unexpected finding(s):`,
    );
    for (const finding of result.unexpected) {
      console.error(`- ${describeFinding(finding)}`);
    }
  }

  if (result.missing.length > 0) {
    rejected = true;
    console.error(
      `Secret-detection gate rejected an incomplete MR !100 history scan; ${result.missing.length} reviewed historical finding(s) were missing:`,
    );
    for (const finding of result.missing) {
      console.error(`- ${describeExpectedFinding(finding)}`);
    }
  }

  if (rejected) {
    process.exitCode = 1;
    return;
  }

  if (result.allowed > 0) {
    console.log(
      `Secret-detection gate accepted exactly ${result.allowed} reviewed MR !100 historical synthetic finding(s); no unexpected findings were present.`,
    );
    return;
  }

  console.log("Secret-detection gate found no vulnerabilities.");
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  await main();
}
