/**
 * Guarded merge-request suggestion application.
 *
 * Keeps suggestion discovery, source-range validation, exact reviewed-head
 * checks, commit-parent verification, and postconditions beside the mutation
 * workflows whose safety they enforce.
 */

import * as z from "zod/v4";

import { encodePathSegment } from "../../gitlab-client.mjs";
import { WRITE } from "../annotations.mjs";
import { project, iid } from "../schemas.mjs";
import { p, mr, filePath } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";
import { decodeUtf8Strict } from "../utf8.mjs";

/**
 * Fetch MR metadata and verify the expected head SHA matches.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @param {string} expectedHeadSha - Caller-supplied expected head SHA.
 * @returns {Promise<object>} The MR diff_refs from the GitLab API.
 */
async function validateMrHeadSha(
  client,
  projectValue,
  mergeRequestIid,
  expectedHeadSha,
) {
  const mrResp = (
    await client.request(mr(projectValue, mergeRequestIid), {
      query: {
        include_diverged_commits_count: false,
        include_rebase_in_progress: false,
      },
    })
  ).data;
  const currentHeadSha = mrResp?.diff_refs?.head_sha;
  if (!currentHeadSha) {
    throw new Error(
      "Could not determine the current MR head SHA. The MR may not have any diffs.",
    );
  }
  if (currentHeadSha !== expectedHeadSha) {
    throw new Error(
      `expected_head_sha mismatch: the MR head is "${currentHeadSha}" but the caller expected "${expectedHeadSha}". The MR has changed since the caller last reviewed it. Re-read the MR and retry.`,
    );
  }
  return mrResp;
}

/**
 * Fetch all pages of discussions for the MR.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @returns {Promise<Array<object>>} All discussion objects.
 */
async function fetchAllDiscussions(client, projectValue, mergeRequestIid) {
  let allDiscussions = [];
  let pageNum = 1;
  const perPage = 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = (
      await client.request(`${mr(projectValue, mergeRequestIid)}/discussions`, {
        query: { page: pageNum, per_page: perPage },
      })
    ).data;
    if (!Array.isArray(page) || page.length === 0) break;
    allDiscussions = allDiscussions.concat(page);
    if (page.length < perPage) break;
    pageNum += 1;
    // Safety cap: 50 pages = 5000 discussions
    if (pageNum > 50) break;
  }
  return allDiscussions;
}

/**
 * Build a suggestion lookup map from MR discussions.
 *
 * Returns a Map<number, { suggestion, note, discussion }> keyed by suggestion ID.
 *
 * @param {object} client - GitLab API client.
 * @param {string|number} projectValue - Project ID or path.
 * @param {number} mergeRequestIid - MR IID.
 * @returns {Promise<Map<number, object>>} Suggestion lookup map.
 */
async function buildSuggestionMap(client, projectValue, mergeRequestIid) {
  const allDiscussions = await fetchAllDiscussions(
    client,
    projectValue,
    mergeRequestIid,
  );
  const map = new Map();
  for (const discussion of allDiscussions) {
    if (!Array.isArray(discussion.notes)) continue;
    for (const note of discussion.notes) {
      if (!Array.isArray(note.suggestions)) continue;
      for (const suggestion of note.suggestions) {
        map.set(suggestion.id, { suggestion, note, discussion });
      }
    }
  }
  return map;
}

/**
 * Validate a single suggestion against the MR discussions.
 *
 * @param {Map} suggestionMap - Map from suggestion ID to { suggestion, note, discussion }.
 * @param {number} suggestionId - The suggestion ID to validate.
 * @returns {object} The validated suggestion entry.
 * @throws {Error} If the suggestion is not found, already applied, or not applicable.
 */
function validateSuggestion(suggestionMap, suggestionId) {
  const entry = suggestionMap.get(suggestionId);
  if (!entry) {
    throw new Error(
      `Suggestion ${suggestionId} was not found in any discussion of the target merge request.`,
    );
  }
  if (entry.suggestion.applied === true) {
    throw new Error(`Suggestion ${suggestionId} has already been applied.`);
  }
  // "appliable" is the field name used in the discussions API response;
  // "applicable" is used in the suggestions apply response. Check both.
  const isApplicable =
    entry.suggestion.applicable === true || entry.suggestion.appliable === true;
  if (!isApplicable) {
    throw new Error(
      `Suggestion ${suggestionId} is not applicable (the diff position may be stale or the file has changed).`,
    );
  }
  return entry;
}

const MAX_SUGGESTION_PREFLIGHT_FILE_BYTES = 500_000;

function suggestionContentLines(content) {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const withoutTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTrailingNewline.length === 0
    ? []
    : withoutTrailingNewline.split("\n");
}

function linesEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

async function loadSuggestionSourceLines(
  client,
  projectValue,
  path,
  expectedHeadSha,
  sourceCache,
) {
  const cacheKey = `${expectedHeadSha}\0${path}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);

  const data = (
    await client.request(filePath(projectValue, path), {
      query: { ref: expectedHeadSha },
    })
  ).data;

  if (data?.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(
      `Could not safely validate suggestion source for "${path}": GitLab did not return base64 repository-file content.`,
    );
  }
  if (
    Number.isSafeInteger(data.size) &&
    data.size > MAX_SUGGESTION_PREFLIGHT_FILE_BYTES
  ) {
    throw new Error(
      `Could not safely validate suggestion source for "${path}": the file exceeds ${MAX_SUGGESTION_PREFLIGHT_FILE_BYTES} bytes.`,
    );
  }

  const bytes = Buffer.from(data.content.replace(/\s/gu, ""), "base64");
  if (bytes.length > MAX_SUGGESTION_PREFLIGHT_FILE_BYTES) {
    throw new Error(
      `Could not safely validate suggestion source for "${path}": the decoded file exceeds ${MAX_SUGGESTION_PREFLIGHT_FILE_BYTES} bytes.`,
    );
  }
  let decoded;
  try {
    decoded = decodeUtf8Strict(bytes, { preserveBom: true });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Could not safely validate suggestion source for "${path}": the file is not valid UTF-8 text.`,
        { cause: error },
      );
    }
    throw error;
  }

  const lines = decoded.replace(/\r\n?/gu, "\n").split("\n");
  sourceCache.set(cacheKey, lines);
  return lines;
}

async function validateSuggestionReplacementContext(
  client,
  projectValue,
  expectedHeadSha,
  entry,
  sourceCache,
) {
  const { suggestion, note } = entry;
  const path = note?.position?.new_path ?? note?.position?.old_path;
  if (
    !path ||
    !Number.isInteger(suggestion.from_line) ||
    !Number.isInteger(suggestion.to_line) ||
    suggestion.from_line < 1 ||
    suggestion.to_line < suggestion.from_line ||
    typeof suggestion.from_content !== "string" ||
    typeof suggestion.to_content !== "string"
  ) {
    return null;
  }

  const sourceLines = await loadSuggestionSourceLines(
    client,
    projectValue,
    path,
    expectedHeadSha,
    sourceCache,
  );
  const currentRange = sourceLines.slice(
    suggestion.from_line - 1,
    suggestion.to_line,
  );
  const expectedRange = suggestionContentLines(suggestion.from_content);
  if (!linesEqual(currentRange, expectedRange)) {
    throw new Error(
      `Suggestion ${suggestion.id} source range does not match its recorded from_content at the expected MR head. Re-read the MR before applying it.`,
    );
  }

  const replacementLines = suggestionContentLines(suggestion.to_content);
  const previousLine =
    suggestion.from_line > 1
      ? sourceLines[suggestion.from_line - 2]
      : undefined;
  const nextLine = sourceLines[suggestion.to_line];

  if (
    replacementLines.length > 0 &&
    previousLine !== undefined &&
    replacementLines[0] === previousLine
  ) {
    throw new Error(
      `Suggestion ${suggestion.id} replacement duplicates unchanged source context immediately before its replacement range. Recreate the suggestion with a range that includes that line or remove the duplicated line.`,
    );
  }
  if (
    replacementLines.length > 0 &&
    nextLine !== undefined &&
    replacementLines.at(-1) === nextLine
  ) {
    throw new Error(
      `Suggestion ${suggestion.id} replacement duplicates unchanged source context immediately after its replacement range. Recreate the suggestion with a range that includes that line or remove the duplicated line.`,
    );
  }

  return {
    path,
    sourceLines,
    fromLine: suggestion.from_line,
    toLine: suggestion.to_line,
    replacementLines,
  };
}

function buildExpectedSuggestionFiles(verifications) {
  const byPath = new Map();
  for (const verification of verifications.filter(Boolean)) {
    let entry = byPath.get(verification.path);
    if (!entry) {
      entry = {
        sourceLines: verification.sourceLines,
        changes: [],
      };
      byPath.set(verification.path, entry);
    }
    entry.changes.push(verification);
  }

  const expectedFiles = new Map();
  for (const [path, entry] of byPath) {
    const ordered = [...entry.changes].sort(
      (left, right) => left.fromLine - right.fromLine,
    );
    let previousToLine = 0;
    for (const change of ordered) {
      if (change.fromLine <= previousToLine) {
        throw new Error(
          `Suggestions for "${path}" contain overlapping replacement ranges. Apply them separately after re-reading the merge request.`,
        );
      }
      previousToLine = change.toLine;
    }

    const lines = [...entry.sourceLines];
    for (const change of ordered.toReversed()) {
      lines.splice(
        change.fromLine - 1,
        change.toLine - change.fromLine + 1,
        ...change.replacementLines,
      );
    }
    expectedFiles.set(path, lines.join("\n"));
  }
  return expectedFiles;
}

async function verifySuggestionFileContents(
  client,
  projectValue,
  currentHeadSha,
  expectedFiles,
) {
  if (expectedFiles.size === 0) return;
  const sourceCache = new Map();
  for (const [path, expectedContent] of expectedFiles) {
    const actualLines = await loadSuggestionSourceLines(
      client,
      projectValue,
      path,
      currentHeadSha,
      sourceCache,
    );
    if (actualLines.join("\n") !== expectedContent) {
      throw new Error(
        `Suggestion apply changed "${path}", but the resulting file does not match the validated replacement content. The branch may have changed; re-read the merge request before continuing.`,
      );
    }
  }
}

async function fetchMrHeadSha(client, projectValue, mergeRequestIid) {
  const response = (
    await client.request(mr(projectValue, mergeRequestIid), {
      query: {
        include_diverged_commits_count: false,
        include_rebase_in_progress: false,
      },
    })
  ).data;
  const headSha = response?.diff_refs?.head_sha;
  if (!headSha) {
    throw new Error(
      "Could not determine the current MR head SHA during post-apply verification.",
    );
  }
  return headSha;
}

async function verifySuggestionCommitParent(
  client,
  projectValue,
  currentHeadSha,
  expectedHeadSha,
) {
  const commit = (
    await client.request(
      `${p(projectValue)}/repository/commits/${encodePathSegment(currentHeadSha)}`,
      { query: { stats: false } },
    )
  ).data;
  const parentIds = commit?.parent_ids;
  if (!Array.isArray(parentIds) || !parentIds.includes(expectedHeadSha)) {
    throw new Error(
      `Suggestion apply changed the MR head to "${currentHeadSha}", but that commit does not directly descend from the reviewed head "${expectedHeadSha}". The branch may include a concurrent change; re-read the merge request before continuing.`,
    );
  }
}

function responseClaimsApplied(data) {
  if (Array.isArray(data)) {
    return data.some((entry) => entry?.applied === true);
  }
  return data?.applied === true;
}

function normalizeVerifiedSuggestionResult(
  mutationData,
  suggestionIds,
  suggestionMap,
  previousHeadSha,
  headSha,
) {
  const metadata = {
    previous_head_sha: previousHeadSha,
    head_sha: headSha,
    post_apply_verified: true,
  };
  if (Array.isArray(mutationData)) {
    const entries = mutationData;
    return suggestionIds.map((id, index) => {
      const responseEntry =
        entries.find((entry) => entry?.id === id) ?? entries[index];
      return {
        ...(responseEntry && typeof responseEntry === "object"
          ? responseEntry
          : { id }),
        applied: suggestionMap.get(id)?.suggestion?.applied === true,
        ...metadata,
      };
    });
  }

  const id = suggestionIds[0];
  return {
    ...(mutationData && typeof mutationData === "object"
      ? mutationData
      : { id }),
    applied: suggestionMap.get(id)?.suggestion?.applied === true,
    ...metadata,
  };
}

async function verifySuggestionApplyPostcondition(
  client,
  projectValue,
  mergeRequestIid,
  suggestionIds,
  expectedHeadSha,
  mutationData,
  expectedFiles = new Map(),
) {
  let currentHeadSha;
  let suggestionMap;
  try {
    currentHeadSha = await fetchMrHeadSha(
      client,
      projectValue,
      mergeRequestIid,
    );
    if (currentHeadSha !== expectedHeadSha) {
      await verifySuggestionCommitParent(
        client,
        projectValue,
        currentHeadSha,
        expectedHeadSha,
      );
    }
    suggestionMap = await buildSuggestionMap(
      client,
      projectValue,
      mergeRequestIid,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Suggestion apply postcondition is ambiguous: ${message} The branch may have changed; re-read the merge request before continuing.`,
    );
  }

  const postStates = suggestionIds.map(
    (id) => suggestionMap.get(id)?.suggestion,
  );
  const allObserved = postStates.every(Boolean);
  const anyApplied = postStates.some((state) => state?.applied === true);
  const allApplied =
    allObserved && postStates.every((state) => state.applied === true);
  const headChanged = currentHeadSha !== expectedHeadSha;

  if (headChanged && allApplied) {
    try {
      await verifySuggestionFileContents(
        client,
        projectValue,
        currentHeadSha,
        expectedFiles,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Suggestion apply postcondition is ambiguous: ${message}`,
      );
    }
    return normalizeVerifiedSuggestionResult(
      mutationData,
      suggestionIds,
      suggestionMap,
      expectedHeadSha,
      currentHeadSha,
    );
  }

  if (
    !headChanged &&
    allObserved &&
    !anyApplied &&
    !responseClaimsApplied(mutationData)
  ) {
    return normalizeVerifiedSuggestionResult(
      mutationData,
      suggestionIds,
      suggestionMap,
      expectedHeadSha,
      currentHeadSha,
    );
  }

  const observedCount = postStates.filter(Boolean).length;
  const appliedCount = postStates.filter(
    (state) => state?.applied === true,
  ).length;
  throw new Error(
    `Suggestion apply postcondition is inconsistent: MR head changed=${headChanged}, observed ${observedCount}/${suggestionIds.length} suggestion(s), applied ${appliedCount}/${suggestionIds.length}. The branch may have changed; re-read the merge request before continuing.`,
  );
}

/**
 * Register guarded merge-request suggestion tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerMergeRequestSuggestionTools(tool) {
  // ── Suggestion tools ────────────────────────────────────────────────
  tool(
    "apply_merge_request_suggestion",
    {
      title: "Apply merge request suggestion",
      description:
        "Apply a single GitLab code suggestion by its suggestion ID. Preflights the reviewed MR head, suggestion state, and replacement-range context, then verifies the resulting MR head and suggestion state after GitLab processes the write. Returns verified head metadata with the suggestion state. An explicit acknowledgement is required. GitLab's apply endpoint has no expected-head parameter, so ambiguous concurrent changes are reported as errors.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        suggestion_id: z.number().int().positive(),
        expected_head_sha: z
          .string()
          .min(1)
          .describe(
            "The MR head SHA the caller last reviewed. The tool rejects the mutation if the current MR head differs.",
          ),
        commit_message: z.string().optional(),
        acknowledge: z
          .boolean()
          .describe(
            "Must be true to confirm the suggestion should be applied.",
          ),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      if (!args.acknowledge) {
        throw new Error(
          "Suggestion application requires acknowledge: true to confirm the mutation.",
        );
      }

      // Preflight 1: validate MR head SHA
      await validateMrHeadSha(
        client,
        args.project,
        args.merge_request_iid,
        args.expected_head_sha,
      );

      // Preflight 2: fetch discussions and validate the suggestion
      const suggestionMap = await buildSuggestionMap(
        client,
        args.project,
        args.merge_request_iid,
      );
      const suggestionEntry = validateSuggestion(
        suggestionMap,
        args.suggestion_id,
      );
      const suggestionVerification = await validateSuggestionReplacementContext(
        client,
        args.project,
        args.expected_head_sha,
        suggestionEntry,
        new Map(),
      );
      const expectedFiles = buildExpectedSuggestionFiles([
        suggestionVerification,
      ]);

      // Mutation
      const mutationData = (
        await client.request(`/suggestions/${args.suggestion_id}/apply`, {
          method: "PUT",
          body: cleanBody({ commit_message: args.commit_message }),
        })
      ).data;

      return verifySuggestionApplyPostcondition(
        client,
        args.project,
        args.merge_request_iid,
        [args.suggestion_id],
        args.expected_head_sha,
        mutationData,
        expectedFiles,
      );
    },
  );

  tool(
    "batch_apply_merge_request_suggestions",
    {
      title: "Batch apply merge request suggestions",
      description:
        "Apply multiple GitLab code suggestions in one GitLab commit. Preflights the reviewed MR head, each suggestion state, and replacement-range context before mutation, then verifies the resulting MR head and every applied state after GitLab processes the write. The entire batch is rejected when any preflight fails. Returns verified head metadata with each suggestion state. An explicit acknowledgement is required; ambiguous concurrent changes are reported as errors.",
      inputSchema: {
        project,
        merge_request_iid: iid,
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(50)
          .describe(
            "Suggestion IDs to apply in a single batch (1–50 suggestions).",
          ),
        expected_head_sha: z
          .string()
          .min(1)
          .describe(
            "The MR head SHA the caller last reviewed. The tool rejects the batch if the current MR head differs.",
          ),
        commit_message: z.string().optional(),
        acknowledge: z
          .boolean()
          .describe(
            "Must be true to confirm the suggestions should be applied.",
          ),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      if (!args.acknowledge) {
        throw new Error(
          "Batch suggestion application requires acknowledge: true to confirm the mutation.",
        );
      }

      // Preflight 1: validate MR head SHA
      await validateMrHeadSha(
        client,
        args.project,
        args.merge_request_iid,
        args.expected_head_sha,
      );

      // Preflight 2: fetch discussions and validate every suggestion
      const suggestionMap = await buildSuggestionMap(
        client,
        args.project,
        args.merge_request_iid,
      );

      const invalidIds = [];
      const verifications = [];
      const sourceCache = new Map();
      for (const id of args.ids) {
        try {
          const suggestionEntry = validateSuggestion(suggestionMap, id);
          const verification = await validateSuggestionReplacementContext(
            client,
            args.project,
            args.expected_head_sha,
            suggestionEntry,
            sourceCache,
          );
          if (verification) verifications.push(verification);
        } catch (err) {
          invalidIds.push({ id, reason: err.message });
        }
      }

      if (invalidIds.length > 0) {
        throw new Error(
          `Batch rejected: ${invalidIds.length} suggestion(s) failed preflight validation. ${JSON.stringify(invalidIds)}`,
        );
      }

      let expectedFiles;
      try {
        expectedFiles = buildExpectedSuggestionFiles(verifications);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Batch rejected: ${message}`);
      }

      // Mutation
      const mutationData = (
        await client.request("/suggestions/batch_apply", {
          method: "PUT",
          body: cleanBody({
            ids: args.ids,
            commit_message: args.commit_message,
          }),
        })
      ).data;

      return verifySuggestionApplyPostcondition(
        client,
        args.project,
        args.merge_request_iid,
        args.ids,
        args.expected_head_sha,
        mutationData,
        expectedFiles,
      );
    },
  );
}
