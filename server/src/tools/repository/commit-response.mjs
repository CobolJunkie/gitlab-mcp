/**
 * Bounded repository commit response shaping shared by revert and cherry-pick.
 */

import { cleanBody } from "../responses.mjs";

export function boundedCommitText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

export function boundedRevertCommit(commit) {
  return cleanBody({
    id: commit?.id,
    short_id: boundedCommitText(commit?.short_id, 64),
    title: boundedCommitText(commit?.title, 500),
    message: boundedCommitText(commit?.message, 4_000),
    parent_ids: Array.isArray(commit?.parent_ids)
      ? commit.parent_ids.slice(0, 8)
      : undefined,
    author_name: boundedCommitText(commit?.author_name, 500),
    authored_date: commit?.authored_date,
    committer_name: boundedCommitText(commit?.committer_name, 500),
    committed_date: commit?.committed_date,
    created_at: commit?.created_at,
    web_url: boundedCommitText(commit?.web_url, 2_000),
  });
}
