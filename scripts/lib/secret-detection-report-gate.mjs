const MR_100_IID = "100";
const MR_100_PROJECT_PATH = "CobolJunkie/gitlab-codex-plugin";

function historyFindings(file, commit, ids) {
  return ids.map((id) => Object.freeze({ id, file, commit }));
}

export const MR_100_HISTORY_FINDINGS = Object.freeze([
  ...historyFindings(
    "scripts/gen08-materialize.mjs",
    "f1788876283808d875550a44f23b9e163d1fadec",
    [
      "09a35664daed675d6557517741ebd12822b2e26f0f3ba6d7691b96560e9fbfee",
      "921402a85ef20589b2452f025479fadf66a24d05ef3166bfb1626b6126f7cd17",
      "d00dbbac23c12a0b7a870dc37234a55d713237de8c6e4c182bc810bcbec1f589",
    ],
  ),
  ...historyFindings(
    "server/test/webhook-tools.test.mjs",
    "94a686517c1d1f4f2fc6f4fdfee86c243acd30d6",
    [
      "597ec25d5d0e209ecad4b7c3932322aed233f3a630f0b00c0cf29e38dc2cc3f5",
      "6b1890c2e24e69c2e03c28a480c6e01b48d257d5352d379f586ee0c2a301a718",
      "58a308cb1f0d4109519eefffa8d65601215273aa249490717372ce79994e6eec",
    ],
  ),
]);

const MR_100_HISTORY_FINDINGS_BY_ID = new Map(
  MR_100_HISTORY_FINDINGS.map((finding) => [finding.id, finding]),
);

function assertSuccessfulReport(report) {
  if (!report || !Array.isArray(report.vulnerabilities)) {
    throw new TypeError(
      "Secret-detection report must contain a vulnerabilities array.",
    );
  }

  if (report?.scan?.status !== "success") {
    throw new TypeError(
      "Secret-detection report must describe a successful scan.",
    );
  }
}

function isMr100Context({ pipelineSource, mergeRequestIid, projectPath }) {
  return (
    pipelineSource === "merge_request_event" &&
    String(mergeRequestIid) === MR_100_IID &&
    projectPath === MR_100_PROJECT_PATH
  );
}

function findingLocationMatches(vulnerability, expected) {
  return (
    vulnerability?.location?.file === expected.file &&
    vulnerability?.location?.commit?.sha === expected.commit
  );
}

function collectReviewedMr100Findings(vulnerabilities) {
  const seenKnownIds = new Set();
  const unexpected = [];

  for (const vulnerability of vulnerabilities) {
    const expected = MR_100_HISTORY_FINDINGS_BY_ID.get(vulnerability?.id);
    if (
      !expected ||
      seenKnownIds.has(vulnerability.id) ||
      !findingLocationMatches(vulnerability, expected)
    ) {
      unexpected.push(vulnerability);
      continue;
    }

    seenKnownIds.add(vulnerability.id);
  }

  return { seenKnownIds, unexpected };
}

function missingReviewedMr100Findings(seenKnownIds) {
  return MR_100_HISTORY_FINDINGS.filter(
    (finding) => !seenKnownIds.has(finding.id),
  );
}

export function validateSecretDetectionReport(
  report,
  { pipelineSource = "", mergeRequestIid = "", projectPath = "" } = {},
) {
  assertSuccessfulReport(report);

  const context = { pipelineSource, mergeRequestIid, projectPath };
  if (!isMr100Context(context)) {
    return {
      total: report.vulnerabilities.length,
      allowed: 0,
      unexpected: [...report.vulnerabilities],
      missing: [],
    };
  }

  const { seenKnownIds, unexpected } = collectReviewedMr100Findings(
    report.vulnerabilities,
  );

  return {
    total: report.vulnerabilities.length,
    allowed: seenKnownIds.size,
    unexpected,
    missing: missingReviewedMr100Findings(seenKnownIds),
  };
}
