/**
 * Repository tools for the GitLab MCP server.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { GitLabApiError, encodePathSegment } from "../gitlab-client.mjs";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import { project, nonEmpty, page, perPage, sha } from "./schemas.mjs";
import { p, filePath } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

function selectTextLines(text, startLine, endLine) {
  if (startLine === undefined && endLine === undefined) {
    return { content: text };
  }
  const start = startLine || 1;
  const end = endLine || Number.MAX_SAFE_INTEGER;
  if (end < start) {
    throw new Error("end_line must be greater than or equal to start_line.");
  }
  const lines = text.split(/\r?\n/);
  return {
    content: lines.slice(start - 1, end).join("\n"),
    lineRange: {
      start,
      end: Math.min(end, lines.length),
      total: lines.length,
    },
  };
}

/**
 * Register repository tools.
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerRepositoryTools(tool) {
  // ── Repository read/navigation tools ──────────────────────────────────

  tool(
    "list_repository_tree",
    {
      title: "List repository tree",
      description:
        "List files and directories in a GitLab repository at a branch, tag, or commit.",
      inputSchema: {
        project,
        path: z.string().optional(),
        ref: z.string().optional(),
        recursive: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/tree`, { query });
    },
  );

  tool(
    "search_code",
    {
      title: "Search GitLab repository code",
      description:
        "Search blobs in a specific GitLab project. Use plain code terms, filenames, symbols, or error text.",
      inputSchema: {
        project,
        search: nonEmpty,
        ref: z.string().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/search`, {
        query: { ...query, scope: "blobs" },
      });
    },
  );

  tool(
    "get_blob",
    {
      title: "Get repository blob",
      description:
        "Fetch repository blob content by Git object SHA. UTF-8 text is decoded by default; binary content remains bounded base64.",
      inputSchema: {
        project,
        blob_sha: z.string().min(7),
        decode_text: z.boolean().default(true),
        max_bytes: z.number().int().min(1_000).max(10_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const result = (
        await client.request(
          `${p(args.project)}/repository/blobs/${encodePathSegment(args.blob_sha)}/raw`,
          {
            responseType: "binary",
            maxBytes: args.max_bytes || 1_000_000,
          },
        )
      ).data;
      if (args.decode_text && result?.content) {
        const bytes = Buffer.from(result.content, "base64");
        const decoded = bytes.toString("utf8");
        if (!decoded.includes("\uFFFD")) {
          return {
            sha: args.blob_sha,
            ...result,
            content: decoded,
            encoding: "utf-8",
          };
        }
      }
      return { sha: args.blob_sha, ...result };
    },
  );

  tool(
    "get_file",
    {
      title: "Get repository file",
      description:
        "Fetch one repository file at a ref. Text is decoded from base64 by default; binary or unusually large content stays base64.",
      inputSchema: {
        project,
        path: nonEmpty,
        ref: z.string().optional(),
        decode_text: z.boolean().default(true),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const response = await client.request(filePath(args.project, args.path), {
        query: { ref: args.ref || "HEAD" },
      });
      const data = response.data;
      if (args.decode_text && data?.encoding === "base64" && data?.content) {
        const bytes = Buffer.from(data.content.replace(/\s/g, ""), "base64");
        const decoded = bytes.toString("utf8");
        if (!decoded.includes("\uFFFD") && bytes.length <= 500_000) {
          return {
            ...data,
            ...selectTextLines(decoded, args.start_line, args.end_line),
            encoding: "utf-8",
          };
        }
      }
      if (args.start_line !== undefined || args.end_line !== undefined) {
        throw new Error(
          "Line ranges require UTF-8 text content within the decode limit.",
        );
      }
      return data;
    },
  );

  tool(
    "fetch_gitlab_file_url",
    {
      title: "Fetch GitLab repository file URL",
      description:
        "Fetch bounded UTF-8 repository-file content from a same-instance GitLab blob, raw, or repository-files API URL.",
      inputSchema: {
        url: z.string().url(),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        max_bytes: z.number().int().min(1_000).max(1_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const url = new URL(args.url);
      const configured = new URL(client.baseUrl);
      if (url.origin !== configured.origin || url.username || url.password) {
        throw new Error(
          "Repository file URL must use the configured GitLab instance.",
        );
      }
      if (url.pathname.includes("/-/blob/")) {
        url.pathname = url.pathname.replace("/-/blob/", "/-/raw/");
      }
      const isRepositoryFile =
        url.pathname.includes("/-/raw/") ||
        (/^\/api\/v4\/projects\/.+\/repository\/files\/.+\/raw$/.test(
          url.pathname,
        ) &&
          url.searchParams.has("ref"));
      if (!isRepositoryFile) {
        throw new Error(
          "Only GitLab repository blob, raw, or repository-files raw URLs are allowed.",
        );
      }
      const result = (
        await client.request(url, {
          responseType: "text",
          maxBytes: args.max_bytes || 500_000,
        })
      ).data;
      if (result.includes("\uFFFD")) {
        throw new Error(
          "Repository URL did not return valid UTF-8 text; use get_blob for bounded base64 content.",
        );
      }
      return {
        url: url.toString(),
        ...selectTextLines(result, args.start_line, args.end_line),
      };
    },
  );

  tool(
    "download_gitlab_attachment",
    {
      title: "Download GitLab attachment",
      description:
        "Download a same-instance GitLab issue or merge-request upload as bounded base64 data. Only GitLab upload paths are accepted.",
      inputSchema: {
        url: z.string().url(),
        max_bytes: z.number().int().min(1_000).max(10_000_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const url = new URL(args.url);
      const configured = new URL(client.baseUrl);
      if (url.origin !== configured.origin) {
        throw new Error(
          "Attachment URL must use the configured GitLab instance.",
        );
      }
      if (!/(?:\/-)?\/uploads\//.test(url.pathname)) {
        throw new Error("Only GitLab upload attachment paths are allowed.");
      }
      return (
        await client.request(url, {
          responseType: "binary",
          maxBytes: args.max_bytes || 5_000_000,
        })
      ).data;
    },
  );

  // ── Repository file mutation tools ────────────────────────────────────

  const fileWriteSchema = {
    project,
    path: nonEmpty,
    branch: nonEmpty,
    content: z.string(),
    commit_message: nonEmpty,
    start_branch: z.string().optional(),
    author_email: z.string().email().optional(),
    author_name: z.string().optional(),
  };

  tool(
    "create_file",
    {
      title: "Create repository file",
      description:
        "Create a new UTF-8 or base64 repository file and commit it to an existing branch.",
      inputSchema: {
        ...fileWriteSchema,
        encoding: z.enum(["text", "base64"]).default("text"),
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(filePath(args.project, args.path), {
          method: "POST",
          body: cleanBody({
            branch: args.branch,
            content: args.content,
            commit_message: args.commit_message,
            start_branch: args.start_branch,
            author_email: args.author_email,
            author_name: args.author_name,
            encoding: args.encoding,
          }),
        })
      ).data,
  );

  tool(
    "update_file",
    {
      title: "Update repository file",
      description:
        "Replace a repository file and commit the change. Supply last_commit_id to prevent overwriting a concurrent edit.",
      inputSchema: {
        ...fileWriteSchema,
        encoding: z.enum(["text", "base64"]).default("text"),
        last_commit_id: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(filePath(args.project, args.path), {
          method: "PUT",
          body: cleanBody({
            branch: args.branch,
            content: args.content,
            commit_message: args.commit_message,
            start_branch: args.start_branch,
            author_email: args.author_email,
            author_name: args.author_name,
            encoding: args.encoding,
            last_commit_id: args.last_commit_id,
          }),
        })
      ).data,
  );

  tool(
    "delete_file",
    {
      title: "Delete repository file",
      description:
        "Delete a repository file and commit the deletion. Supply last_commit_id to guard against concurrent edits.",
      inputSchema: {
        project,
        path: nonEmpty,
        branch: nonEmpty,
        commit_message: nonEmpty,
        start_branch: z.string().optional(),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
        last_commit_id: nonEmpty,
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const { project: projectValue, path, ...body } = args;
      return (
        await client.request(filePath(projectValue, path), {
          method: "DELETE",
          body,
        })
      ).data;
    },
  );

  // ── Branch and commit read tools ──────────────────────────────────────

  tool(
    "list_branches",
    {
      title: "List repository branches",
      description: "List or search branches in a GitLab project.",
      inputSchema: {
        project,
        search: z.string().optional(),
        regex: z.string().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/branches`, {
        query,
      });
    },
  );

  tool(
    "create_branch",
    {
      title: "Create repository branch",
      description:
        "Create a branch from an existing branch, tag, or commit SHA.",
      inputSchema: {
        project,
        branch: nonEmpty,
        ref: nonEmpty,
      },
      annotations: WRITE,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/repository/branches`, {
          method: "POST",
          query: { branch: args.branch, ref: args.ref },
        })
      ).data,
  );

  tool(
    "delete_branch",
    {
      title: "Delete repository branch",
      description:
        "Delete a GitLab repository branch. Protected branches cannot be deleted through this operation.",
      inputSchema: {
        project,
        branch: nonEmpty,
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/repository/branches/${encodePathSegment(args.branch)}`,
          { method: "DELETE" },
        )
      ).data,
  );

  tool(
    "list_commits",
    {
      title: "List repository commits",
      description:
        "List commits for a project, optionally scoped to a ref, path, or time range.",
      inputSchema: {
        project,
        ref_name: z.string().optional(),
        path: z.string().optional(),
        since: z.string().datetime({ offset: true }).optional(),
        until: z.string().datetime({ offset: true }).optional(),
        all: z.boolean().optional(),
        with_stats: z.boolean().optional(),
        first_parent: z.boolean().optional(),
        order: z.enum(["default", "topo"]).optional(),
        trailers: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/repository/commits`, { query });
    },
  );

  tool(
    "get_commit",
    {
      title: "Get repository commit",
      description: "Fetch a GitLab commit and its optional diff statistics.",
      inputSchema: {
        project,
        sha,
        stats: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/repository/commits/${encodePathSegment(args.sha)}`,
          { query: { stats: args.stats } },
        )
      ).data,
  );

  tool(
    "compare_refs",
    {
      title: "Compare repository refs",
      description:
        "Compare two branches, tags, or commits and return commits plus per-file diffs.",
      inputSchema: {
        project,
        from: nonEmpty,
        to: nonEmpty,
        straight: z.boolean().optional(),
        unidiff: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(`${p(args.project)}/repository/compare`, {
          query: {
            from: args.from,
            to: args.to,
            straight: args.straight,
            unidiff: args.unidiff,
          },
        })
      ).data,
  );

  tool(
    "list_commit_diffs",
    {
      title: "List commit diffs",
      description:
        "Return the files and patch hunks changed by one GitLab commit.",
      inputSchema: {
        project,
        sha,
        unidiff: z.boolean().optional(),
        page,
        per_page: perPage,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      client.request(
        `${p(args.project)}/repository/commits/${encodePathSegment(args.sha)}/diff`,
        {
          query: {
            unidiff: args.unidiff,
            page: args.page,
            per_page: args.per_page,
          },
        },
      ),
  );

  // ── Safe commit creation ──────────────────────────────────────────────

  const safeCommitAction = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      file_path: nonEmpty,
      content: z.string(),
      encoding: z.enum(["text", "base64"]).optional(),
      execute_filemode: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("update"),
      file_path: nonEmpty,
      content: z.string(),
      encoding: z.enum(["text", "base64"]).optional(),
      last_commit_id: z.string().optional(),
      execute_filemode: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("move"),
      file_path: nonEmpty,
      previous_path: nonEmpty,
      content: z.string().optional(),
      encoding: z.enum(["text", "base64"]).optional(),
      last_commit_id: z.string().optional(),
    }),
    z.object({
      action: z.literal("chmod"),
      file_path: nonEmpty,
      execute_filemode: z.boolean(),
    }),
  ]);

  tool(
    "create_commit",
    {
      title: "Create repository commit",
      description:
        "Create one GitLab commit containing non-destructive atomic create, update, move, or chmod actions. update and move require a per-file last_commit_id to guard against concurrent overwrites. Do not supply both start_branch and start_sha; use start_branch for new-branch creation only.",
      inputSchema: {
        project,
        branch: nonEmpty,
        commit_message: nonEmpty,
        actions: z.array(safeCommitAction).min(1).max(100),
        start_branch: z.string().optional(),
        start_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .optional()
          .describe(
            "Full 40-character commit SHA for new-branch creation. Mutually exclusive with start_branch.",
          ),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        start_branch: startBranch,
        start_sha: startSha,
        actions,
        ...rest
      } = args;
      if (startBranch && startSha) {
        throw new Error(
          "create_commit does not accept both start_branch and start_sha. Use start_branch for new-branch creation only.",
        );
      }
      for (const action of actions) {
        if (
          action.action !== "create" &&
          action.action !== "chmod" &&
          (!action.last_commit_id || action.last_commit_id === "")
        ) {
          throw new Error(
            `${action.action} action on '${action.file_path}' requires last_commit_id to prevent concurrent overwrites.`,
          );
        }
      }
      return (
        await client.request(`${p(projectValue)}/repository/commits`, {
          method: "POST",
          body: cleanBody({
            ...rest,
            actions,
            start_branch: startBranch,
            start_sha: startSha,
          }),
        })
      ).data;
    },
  );

  // ── Destructive commit creation ───────────────────────────────────────

  const destructiveCommitAction = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("delete"),
      file_path: nonEmpty,
      last_commit_id: nonEmpty.describe(
        "Current file commit ID required to prevent deleting a concurrently changed file.",
      ),
    }),
    ...safeCommitAction.options,
  ]);

  tool(
    "create_destructive_commit",
    {
      title: "Create destructive repository commit",
      description:
        "Create one GitLab commit that can delete files or force a branch update. For ordinary updates, the branch tip must match start_sha before the commit is submitted; forced updates use start_sha as GitLab's explicit replacement parent. Delete actions also require last_commit_id.",
      outputSchema: {
        result: z
          .unknown()
          .describe(
            "Created destructive GitLab commit, including its commit ID, SHA, and affected file actions when GitLab returns them.",
          ),
      },
      inputSchema: {
        project,
        branch: nonEmpty,
        commit_message: nonEmpty,
        actions: z.array(destructiveCommitAction).min(1).max(100),
        start_sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .describe(
            "Reviewed commit SHA from which GitLab must apply this destructive change.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Allow GitLab to force the branch update. Use only after explicitly reviewing the target ref.",
          ),
        author_email: z.string().email().optional(),
        author_name: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      const {
        project: projectValue,
        start_sha: startSha,
        force,
        ...body
      } = args;
      if (!force) {
        const branchPath = `${p(projectValue)}/repository/branches/${encodePathSegment(args.branch)}`;
        const branch = await client.request(branchPath);
        if (branch.data?.commit?.id !== startSha) {
          throw new GitLabApiError(
            "Destructive commit rejected because the target branch no longer matches start_sha.",
            {
              status: 409,
              method: "GET",
              path: branchPath,
              response: {
                expected_start_sha: startSha,
                actual_branch_sha: branch.data?.commit?.id,
              },
            },
          );
        }
      }
      return (
        await client.request(`${p(projectValue)}/repository/commits`, {
          method: "POST",
          body: cleanBody(
            force ? { ...body, start_sha: startSha, force } : body,
          ),
        })
      ).data;
    },
  );
}
