/**
 * Repository content retrieval and navigation tools.
 *
 * Exact file-content verification stays here because it protects get_file.
 */

import { createHash } from "node:crypto";

import * as z from "zod/v4";

import { encodePathSegment } from "../../gitlab-client.mjs";
import { READ_ONLY } from "../annotations.mjs";
import { project, nonEmpty, page, perPage } from "../schemas.mjs";
import { p, filePath } from "../paths.mjs";
import { decodeUtf8Strict, tryDecodeUtf8Strict } from "../utf8.mjs";

function gitBlobHashAlgorithm(blobId) {
  if (typeof blobId !== "string") return undefined;
  if (/^[0-9a-f]{40}$/i.test(blobId)) return "sha1";
  if (/^[0-9a-f]{64}$/i.test(blobId)) return "sha256";
  return undefined;
}

function gitBlobIdForBytes(bytes, blobId) {
  const algorithm = gitBlobHashAlgorithm(blobId);
  if (!algorithm) return undefined;
  return createHash(algorithm)
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repositoryFileSizeMismatch(data, bytes) {
  return (
    Number.isSafeInteger(data.size) &&
    data.size >= 0 &&
    bytes.length !== data.size
  );
}

async function ensureExactRepositoryFileContent(
  client,
  projectValue,
  data,
  bytes,
) {
  const expectedBlobId =
    typeof data.blob_id === "string" ? data.blob_id.toLowerCase() : "";
  const fileBlobId = gitBlobIdForBytes(bytes, data.blob_id);
  const blobMismatch =
    fileBlobId !== undefined && fileBlobId !== expectedBlobId;
  if (!repositoryFileSizeMismatch(data, bytes) && !blobMismatch) {
    return { data, bytes };
  }
  if (fileBlobId === undefined) {
    throw new Error(
      "GitLab repository-file content does not match its file metadata, and no valid blob_id is available for exact recovery.",
    );
  }

  const raw = (
    await client.request(
      `${p(projectValue)}/repository/blobs/${encodePathSegment(data.blob_id)}/raw`,
      {
        responseType: "binary",
        maxBytes: 1_000_000,
      },
    )
  ).data;
  if (raw?.encoding !== "base64" || typeof raw.content !== "string") {
    throw new Error(
      "GitLab repository-file content does not match its file metadata, and raw blob recovery did not return base64 content.",
    );
  }

  const rawBytes = Buffer.from(raw.content.replace(/\s/g, ""), "base64");
  const rawBlobId = gitBlobIdForBytes(rawBytes, data.blob_id);
  if (
    rawBlobId !== expectedBlobId ||
    repositoryFileSizeMismatch(data, rawBytes)
  ) {
    throw new Error(
      "GitLab repository-file content does not match its file metadata, and raw blob recovery did not match the authoritative blob.",
    );
  }

  const recovered = { ...data, content: raw.content };
  if (typeof data.content_sha256 === "string") {
    recovered.content_sha256 = createHash("sha256")
      .update(rawBytes)
      .digest("hex");
  }
  return { data: recovered, bytes: rawBytes };
}

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
  if (start > lines.length) {
    throw new Error(
      `start_line ${start} exceeds file line count ${lines.length}.`,
    );
  }
  return {
    content: lines.slice(start - 1, end).join("\n"),
    lineRange: {
      start,
      end: Math.min(end, lines.length),
      total: lines.length,
    },
  };
}

export function registerRepositoryContentTools(tool) {
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
        const decoded = tryDecodeUtf8Strict(bytes, { preserveBom: true });
        if (decoded !== undefined) {
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
        "Fetch one repository file at a ref. Text is decoded from base64 by default; binary or unusually large content stays base64. Line ranges are 1-based; start_line beyond EOF is rejected and end_line beyond EOF is clamped to the final line.",
      inputSchema: {
        project,
        path: nonEmpty,
        ref: z.string().optional(),
        decode_text: z.boolean().default(true),
        start_line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based start line; must not exceed the file line count."),
        end_line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "1-based inclusive end line; must be greater than or equal to start_line. Values past EOF are clamped to the final line.",
          ),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const response = await client.request(filePath(args.project, args.path), {
        query: { ref: args.ref || "HEAD" },
      });
      let data = response.data;
      let bytes;
      if (data?.encoding === "base64" && typeof data.content === "string") {
        bytes = Buffer.from(data.content.replace(/\s/g, ""), "base64");
        ({ data, bytes } = await ensureExactRepositoryFileContent(
          client,
          args.project,
          data,
          bytes,
        ));
      }

      const hasLineRange =
        args.start_line !== undefined || args.end_line !== undefined;
      if (
        args.decode_text &&
        bytes &&
        (data.content.length > 0 || hasLineRange)
      ) {
        if (bytes.length <= 500_000) {
          const decoded = tryDecodeUtf8Strict(bytes, { preserveBom: true });
          if (decoded !== undefined) {
            return {
              ...data,
              ...selectTextLines(decoded, args.start_line, args.end_line),
              encoding: "utf-8",
            };
          }
        }
      }
      if (hasLineRange) {
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
        "Fetch bounded UTF-8 repository-file content from a same-instance GitLab blob, raw, or repository-files API URL. Line ranges are 1-based; start_line beyond EOF is rejected and end_line beyond EOF is clamped to the final line.",
      inputSchema: {
        url: z.string().url(),
        start_line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based start line; must not exceed the file line count."),
        end_line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "1-based inclusive end line; must be greater than or equal to start_line. Values past EOF are clamped to the final line.",
          ),
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
          responseType: "binary",
          maxBytes: args.max_bytes || 500_000,
        })
      ).data;
      const bytes = Buffer.from(result.content, "base64");
      let decoded;
      try {
        decoded = decodeUtf8Strict(bytes, { preserveBom: true });
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error(
            "Repository URL did not return valid UTF-8 text; use get_blob for bounded base64 content.",
            { cause: error },
          );
        }
        throw error;
      }
      return {
        url: url.toString(),
        ...selectTextLines(decoded, args.start_line, args.end_line),
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
}
