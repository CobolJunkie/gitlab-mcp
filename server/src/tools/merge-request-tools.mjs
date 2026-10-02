/**
 * Merge-request tool-family composition for the GitLab MCP server.
 *
 * This remains the stable merge-request-domain registration boundary. Workflow
 * logic lives in cohesive internal modules under ./merge-request/.
 */

import { registerMergeRequestLifecycleTools } from "./merge-request/lifecycle-tools.mjs";
import { registerMergeRequestReviewTools } from "./merge-request/review-tools.mjs";
import {
  registerMergeRequestDiscussionTools,
  registerMergeRequestReactionTools,
} from "./merge-request/collaboration-tools.mjs";
import { registerMergeRequestSuggestionTools } from "./merge-request/suggestion-tools.mjs";

export function registerMergeRequestTools(tool) {
  registerMergeRequestLifecycleTools(tool);
  registerMergeRequestReviewTools(tool);
  registerMergeRequestDiscussionTools(tool);
  registerMergeRequestSuggestionTools(tool);
  registerMergeRequestReactionTools(tool);
}
