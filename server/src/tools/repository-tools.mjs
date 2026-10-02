/**
 * Repository tool-family composition for the GitLab MCP server.
 *
 * This is the stable repository-domain registration boundary. Workflow logic
 * lives in cohesive internal modules under ./repository/.
 */

import { registerRepositoryContentTools } from "./repository/content-tools.mjs";
import { registerRepositoryFileMutationTools } from "./repository/file-mutation-tools.mjs";
import { registerRepositoryBranchTools } from "./repository/branch-tools.mjs";
import { registerRepositoryHistoryTools } from "./repository/history-tools.mjs";
import { registerRepositoryRevertTool } from "./repository/revert-tool.mjs";
import { registerRepositoryCherryPickTool } from "./repository/cherry-pick-tool.mjs";
import { registerRepositoryPatchTool } from "./repository/patch-tool.mjs";
import { registerRepositoryCommitTools } from "./repository/commit-tools.mjs";

export function registerRepositoryTools(tool) {
  registerRepositoryContentTools(tool);
  registerRepositoryFileMutationTools(tool);
  registerRepositoryBranchTools(tool);
  registerRepositoryHistoryTools(tool);
  registerRepositoryRevertTool(tool);
  registerRepositoryCherryPickTool(tool);
  registerRepositoryPatchTool(tool);
  registerRepositoryCommitTools(tool);
}
