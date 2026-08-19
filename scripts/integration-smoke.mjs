#!/usr/bin/env node

import {
  GitLabClient,
  normalizeGitLabUrl,
} from "../server/src/gitlab-client.mjs";

const project = process.env.GITLAB_INTEGRATION_PROJECT;
const token = process.env.GITLAB_INTEGRATION_TOKEN || process.env.GITLAB_TOKEN;

if (!project || !token) {
  console.log(
    "GitLab integration smoke skipped: set GITLAB_INTEGRATION_PROJECT and GITLAB_INTEGRATION_TOKEN (or GITLAB_TOKEN).",
  );
  process.exit(0);
}

const client = new GitLabClient({
  baseUrl: normalizeGitLabUrl(
    process.env.GITLAB_URL || process.env.CI_SERVER_URL,
  ),
  token,
  timeoutMs: 10_000,
});

const checks = [
  ["project", `/projects/${encodeURIComponent(project)}`],
  [
    "repository tree",
    `/projects/${encodeURIComponent(project)}/repository/tree?per_page=1`,
  ],
  [
    "pipelines",
    `/projects/${encodeURIComponent(project)}/pipelines?per_page=1`,
  ],
];

for (const [name, path] of checks) {
  await client.request(path);
  console.log(`GitLab integration check passed: ${name}`);
}

console.log("GitLab integration smoke completed with read-only API calls.");
