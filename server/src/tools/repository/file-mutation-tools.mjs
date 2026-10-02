/**
 * Repository file mutation tools.
 */

import * as z from "zod/v4";

import { WRITE, DESTRUCTIVE } from "../annotations.mjs";
import { project, nonEmpty } from "../schemas.mjs";
import { filePath } from "../paths.mjs";
import { cleanBody } from "../responses.mjs";

export function registerRepositoryFileMutationTools(tool) {
  // ── Repository file mutation tools ────────────────────────────────────

  const fileStartBranch = z
    .string()
    .optional()
    .describe(
      "Base branch GitLab uses to create the target branch when branch does not already exist. Omit when mutating an existing branch.",
    );

  const fileWriteSchema = {
    project,
    path: nonEmpty,
    branch: nonEmpty,
    content: z.string(),
    commit_message: nonEmpty,
    start_branch: fileStartBranch,
    author_email: z.string().email().optional(),
    author_name: z.string().optional(),
  };

  tool(
    "create_file",
    {
      title: "Create repository file",
      description:
        "Create a new UTF-8 or base64 repository file and commit it. If branch does not exist, supplying start_branch lets GitLab create the target branch from that base as part of this mutation.",
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
        "Replace a repository file and commit the change. If branch does not exist, supplying start_branch lets GitLab create the target branch from that base as part of this mutation. Supply last_commit_id to prevent overwriting a concurrent edit.",
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
        "Delete a repository file and commit the deletion. If branch does not exist, supplying start_branch lets GitLab create the target branch from that base as part of this mutation. Supply last_commit_id to guard against concurrent edits.",
      inputSchema: {
        project,
        path: nonEmpty,
        branch: nonEmpty,
        commit_message: nonEmpty,
        start_branch: fileStartBranch,
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
}
