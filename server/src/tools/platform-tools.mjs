/**
 * Platform tool-family composition for the GitLab MCP server.
 *
 * This remains the stable platform-domain registration boundary. Identity,
 * discovery/search, label lifecycle, and milestone lifecycle logic lives in
 * cohesive internal modules under ./platform/.
 */

import {
  registerPlatformDiscoveryTools,
  registerPlatformProjectMemberTool,
} from "./platform/discovery-tools.mjs";
import { registerPlatformLabelTools } from "./platform/label-tools.mjs";
import { registerPlatformMilestoneTools } from "./platform/milestone-tools.mjs";

export function registerPlatformTools(tool) {
  registerPlatformDiscoveryTools(tool);
  registerPlatformLabelTools(tool);
  registerPlatformMilestoneTools(tool);
  registerPlatformProjectMemberTool(tool);
}
