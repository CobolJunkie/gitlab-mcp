/**
 * Convenience helpers for building common GitLab REST API path segments.
 */

import { encodePathSegment, projectApiPath } from "../gitlab-client.mjs";

export function p(projectValue) {
  return projectApiPath(projectValue);
}

export function g(groupValue) {
  return `/groups/${encodePathSegment(groupValue)}`;
}

export function mr(projectValue, mergeRequestIid) {
  return `${p(projectValue)}/merge_requests/${mergeRequestIid}`;
}

export function issue(projectValue, issueIid) {
  return `${p(projectValue)}/issues/${issueIid}`;
}

export function filePath(projectValue, path) {
  return `${p(projectValue)}/repository/files/${encodePathSegment(path)}`;
}
