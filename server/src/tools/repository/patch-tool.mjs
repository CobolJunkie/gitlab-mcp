/**
 * Guarded exact-hunk repository mutation workflow.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../../gitlab-client.mjs";
import { WRITE } from "../annotations.mjs";
import { project, nonEmpty } from "../schemas.mjs";
import { p, filePath } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";
import { decodeUtf8Strict } from "../utf8.mjs";

const MAX_PATCH_FILE_BYTES = 500_000;

function validatePatchPath(path) {
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe repository patch path: "${path}".`);
  }
}

function decodePatchFile(data, path) {
  if (data?.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(
      `Cannot patch "${path}": GitLab did not return base64 repository-file content.`,
    );
  }
  const bytes = Buffer.from(data.content.replace(/\s/gu, ""), "base64");
  if (bytes.length > MAX_PATCH_FILE_BYTES) {
    throw new Error(
      `Cannot patch "${path}": file exceeds ${MAX_PATCH_FILE_BYTES} bytes.`,
    );
  }
  try {
    return decodeUtf8Strict(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Cannot patch "${path}": file is not valid UTF-8 text.`, {
        cause: error,
      });
    }
    throw error;
  }
}

function findUniqueHunk(content, search, path) {
  const first = content.indexOf(search);
  if (first < 0) {
    throw new Error(
      `Patch context did not match "${path}". Re-read the file and retry against the current reviewed head.`,
    );
  }
  if (content.includes(search, first + 1)) {
    throw new Error(
      `Patch context for "${path}" is ambiguous because it matches more than once.`,
    );
  }
  return first;
}

async function requireBranchHead(
  client,
  projectValue,
  branch,
  expectedHeadSha,
) {
  const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(
    branch,
  )}`;
  const response = await client.request(branchPath);
  const currentHeadSha = response.data?.commit?.id;
  if (currentHeadSha !== expectedHeadSha) {
    throw new GitLabApiError(
      "Repository hunk update rejected because the target branch no longer matches expected_head_sha.",
      {
        status: 409,
        method: "GET",
        path: branchPath,
        response: {
          expected_head_sha: expectedHeadSha,
          actual_branch_sha: currentHeadSha,
        },
      },
    );
  }
}

function groupRepositoryHunks(hunks) {
  const grouped = new Map();
  for (const hunk of hunks) {
    validatePatchPath(hunk.file_path);
    const existing = grouped.get(hunk.file_path);
    if (existing) {
      existing.push(hunk);
    } else {
      grouped.set(hunk.file_path, [hunk]);
    }
  }
  return grouped;
}

function expectedBlobShaFor(path, hunks) {
  const expectedBlobShas = new Set(
    hunks
      .map((hunk) => hunk.expected_blob_sha)
      .filter((value) => value !== undefined),
  );
  if (expectedBlobShas.size > 1) {
    throw new Error(
      `Conflicting expected_blob_sha values were supplied for "${path}".`,
    );
  }
  return [...expectedBlobShas][0];
}

function verifyExpectedBlobSha(projectValue, path, data, hunks) {
  const expectedBlobSha = expectedBlobShaFor(path, hunks);
  if (!expectedBlobSha || data.blob_id === expectedBlobSha) {
    return;
  }
  throw new GitLabApiError(
    `Repository hunk update rejected because "${path}" no longer matches expected_blob_sha.`,
    {
      status: 409,
      method: "GET",
      path: filePath(projectValue, path),
      response: {
        expected_blob_sha: expectedBlobSha,
        actual_blob_sha: data.blob_id,
      },
    },
  );
}

function applyExactHunks(content, hunks, path) {
  let updated = content;
  for (const hunk of hunks) {
    const index = findUniqueHunk(updated, hunk.search, path);
    updated =
      updated.slice(0, index) +
      hunk.replace +
      updated.slice(index + hunk.search.length);
    if (Buffer.byteLength(updated, "utf8") > MAX_PATCH_FILE_BYTES) {
      throw new Error(
        `Cannot patch "${path}": rewritten file exceeds ${MAX_PATCH_FILE_BYTES} bytes.`,
      );
    }
  }
  return updated;
}

async function prepareRepositoryHunkActions(client, args) {
  const actions = [];
  let hunkCount = 0;
  for (const [path, hunks] of groupRepositoryHunks(args.hunks)) {
    const data = (
      await client.request(filePath(args.project, path), {
        query: { ref: args.expected_head_sha },
      })
    ).data;
    if (!data?.last_commit_id) {
      throw new Error(
        `Cannot patch "${path}": GitLab did not return last_commit_id for concurrency protection.`,
      );
    }
    verifyExpectedBlobSha(args.project, path, data, hunks);
    const original = decodePatchFile(data, path);
    const content = applyExactHunks(original, hunks, path);
    if (content === original) {
      throw new Error(
        `Patch hunks for "${path}" do not change the file content.`,
      );
    }
    actions.push({
      action: "update",
      file_path: path,
      content,
      encoding: "text",
      last_commit_id: data.last_commit_id,
    });
    hunkCount += hunks.length;
  }
  return {
    actions,
    changedPaths: actions.map((action) => action.file_path),
    hunkCount,
  };
}

async function verifyRepositoryHunkCommit(client, args, commit) {
  const committedPath = `${p(args.project)}/repository/commits/${encodePathSegment(
    commit.id,
  )}`;
  let committed;
  try {
    committed = (await client.request(committedPath)).data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Repository hunk update postcondition is ambiguous after GitLab accepted the commit: ${message} The branch may have changed; re-read it before making any further mutation.`,
      { cause: error },
    );
  }
  if (
    !Array.isArray(committed?.parent_ids) ||
    committed.parent_ids.length !== 1 ||
    committed.parent_ids[0] !== args.expected_head_sha
  ) {
    throw new GitLabApiError(
      "Repository hunk update completed but the resulting commit does not directly descend from expected_head_sha. The branch may have changed concurrently; re-read it before making any further mutation.",
      {
        status: 409,
        method: "GET",
        path: committedPath,
        response: {
          expected_parent_sha: args.expected_head_sha,
          resulting_commit_sha: commit.id,
          actual_parent_shas: committed?.parent_ids,
        },
      },
    );
  }
  try {
    await requireBranchHead(client, args.project, args.branch, commit.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Repository hunk update committed successfully, but the target branch no longer points at the resulting commit: ${message} The branch changed concurrently; re-read it before making any further mutation.`,
      { cause: error },
    );
  }
}

export function registerRepositoryPatchTool(tool) {
  // ── Guarded exact-hunk mutation ──────────────────────────────────────

  const exactRepositoryHunk = z.object({
    file_path: nonEmpty,
    search: z.string().min(1).max(100_000),
    replace: z.string().max(100_000),
    expected_blob_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional()
      .describe(
        "Optional exact Git blob SHA for the reviewed file version. The mutation fails if GitLab reports another blob.",
      ),
  });

  tool(
    "apply_repository_hunks",
    {
      title: "Apply guarded repository hunks",
      description:
        "Apply one or more exact search/replace hunks to existing UTF-8 repository files in one atomic GitLab commit. The target branch must match expected_head_sha at preflight; each search string must match exactly once at application time, and optional expected_blob_sha guards individual files. The server fetches and rewrites file contents internally so callers do not retransmit whole files.",
      inputSchema: {
        project,
        branch: nonEmpty,
        expected_head_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe("Full reviewed target-branch head SHA."),
        commit_message: nonEmpty,
        hunks: z.array(exactRepositoryHunk).min(1).max(50),
        dry_run: z
          .boolean()
          .default(false)
          .describe(
            "Validate the branch, files, blob guards, and hunk contexts without creating a commit.",
          ),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireBranchHead(
        client,
        args.project,
        args.branch,
        args.expected_head_sha,
      );
      const { actions, changedPaths, hunkCount } =
        await prepareRepositoryHunkActions(client, args);
      await requireBranchHead(
        client,
        args.project,
        args.branch,
        args.expected_head_sha,
      );
      if (args.dry_run) {
        return {
          dry_run: true,
          branch: args.branch,
          expected_head_sha: args.expected_head_sha,
          changed_paths: changedPaths,
          hunk_count: hunkCount,
        };
      }

      const commit = (
        await client.request(`${p(args.project)}/repository/commits`, {
          method: "POST",
          body: cleanBody({
            branch: args.branch,
            commit_message: args.commit_message,
            actions,
            author_email: args.author_email,
            author_name: args.author_name,
          }),
        })
      ).data;
      await verifyRepositoryHunkCommit(client, args, commit);
      return {
        ...commit,
        changed_paths: changedPaths,
        hunk_count: hunkCount,
      };
    },
  );
}
