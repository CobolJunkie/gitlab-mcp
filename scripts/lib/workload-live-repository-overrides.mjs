import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const SEARCH_QUERIES = ["Dedicated non-production fixture", "Safe to mutate"];
const SEARCH_MARKER =
  "Dedicated non-production fixture for the GitLab Codex Plugin disposable integration suite.";
const FETCH_ATTEMPTS = 2;
const REMOTE_RECOVERY_DELAY_MS = 1000;

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function exactReadmeMatch(session, result) {
  return (
    rows(result).find(
      (entry) =>
        entry.path === "README.md" &&
        (entry.project_id === undefined ||
          Number(entry.project_id) === Number(session.project)) &&
        (entry.ref === undefined || entry.ref === session.defaultBranch),
    ) || null
  );
}

function isTransientGitLabToolError(error) {
  let result;
  try {
    if (error?.name !== "LiveBenchmarkToolError") return false;
    result = error.result;
  } catch {
    return false;
  }
  if (result?.error !== "GitLabApiError") return false;

  const status = result.status;
  if (Number.isSafeInteger(status)) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  const message = typeof result.message === "string" ? result.message : "";
  return (
    message.startsWith("GitLab request timed out") ||
    message.startsWith("GitLab request failed:")
  );
}

async function findSearchMatch(session) {
  for (let index = 0; index < SEARCH_QUERIES.length; index += 1) {
    const search = SEARCH_QUERIES[index];
    const hasRemainingAttempt = index + 1 < SEARCH_QUERIES.length;
    let result;
    try {
      result = await session.call("search_code", {
        project: session.project,
        search,
        ref: session.defaultBranch,
        page: 1,
        per_page: 20,
      });
    } catch (error) {
      if (hasRemainingAttempt && isTransientGitLabToolError(error)) continue;
      throw error;
    }
    const match = exactReadmeMatch(session, result);
    if (match) return match;
  }
  return null;
}

async function fetchMatchingFile(session, match) {
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(REMOTE_RECOVERY_DELAY_MS);
    try {
      return await session.call("get_file", {
        project: session.project,
        path: match.path,
        ref: match.ref || session.defaultBranch,
        decode_text: true,
        start_line: 1,
        end_line: 10,
      });
    } catch (error) {
      if (attempt + 1 < FETCH_ATTEMPTS && isTransientGitLabToolError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Benchmark repository fetch exhausted bounded recovery.");
}

function searchFetchHandler(session) {
  return {
    execute: ({ observe }) =>
      session.measured(observe, async () => {
        const match = await findSearchMatch(session);
        assert.ok(
          match,
          "Benchmark repository search did not return the matching README source.",
        );

        const file = await fetchMatchingFile(session, match);
        assert.equal(typeof file?.content, "string");
        assert.equal(
          file.content.includes(SEARCH_MARKER),
          true,
          "Fetched benchmark search result did not contain the fixture marker.",
        );
      }),
    verifyFinalState: async () => ({
      verified: true,
      forbiddenEffectsObserved: [],
    }),
  };
}

export function applyRepositoryWorkloadOverrides(session, handlers) {
  handlers["repository.search-fetch"] = searchFetchHandler(session);
  return handlers;
}
