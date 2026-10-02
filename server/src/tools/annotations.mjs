/**
 * Shared MCP tool annotation sets for read-only, write, and destructive
 * operations. Every registered GitLab tool must declare one of these
 * annotation objects so that MCP clients can reason about safety.
 */

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const IDEMPOTENT_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const gitLabToolAnnotations = {
  READ_ONLY,
  WRITE,
  DESTRUCTIVE,
  IDEMPOTENT_DESTRUCTIVE,
};
