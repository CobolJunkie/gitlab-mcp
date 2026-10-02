import * as z from "zod/v4";

import { resolveDistributionMetadata } from "../../../shared/distribution-metadata.mjs";
import { createToolRegistrar, defaultClientFactory } from "./register.mjs";
import { registerRuntimeTools } from "./runtime-tools.mjs";
import { registerPlatformTools } from "./platform-tools.mjs";
import { registerIssueTools } from "./issue-tools.mjs";
import { registerMergeRequestTools } from "./merge-request-tools.mjs";
import { registerRepositoryTools } from "./repository-tools.mjs";
import { registerPipelineTools } from "./pipeline-tools.mjs";
import { registerGovernanceTools } from "./governance-tools.mjs";
import { registerReleaseTools } from "./release-tools.mjs";
import { registerPipelineScheduleTools } from "./pipeline-schedule-tools.mjs";
import { registerCiVariableTools } from "./ci-variable-tools.mjs";
import { registerProjectAccessTokenTools } from "./project-access-token-tools.mjs";
import { registerDeploymentTools } from "./deployment-tools.mjs";
import { registerWebhookTools } from "./webhook-tools.mjs";
import {
  createToolsetRegistrationRouter,
  frozenToolsetAssignments,
  resolveToolsetSelection,
} from "./toolsets.mjs";

const outputSchema = {
  result: z.unknown().describe("GitLab response normalized for model use."),
};

export function registerGitLabTools(server, options = {}) {
  const {
    clientFactory = defaultClientFactory,
    securitySchemes,
    authChallenge,
    readOnly = false,
    deploymentMode = "embedded",
    buildId = process.env.MCP_BUILD_ID,
    observabilityObserver,
    observabilityToolScope,
    registeredToolObserver,
    registeredToolsetObserver,
    toolsets = process.env.MCP_TOOLSETS,
  } = options;
  const distributionMetadata = resolveDistributionMetadata(options);
  const { tool, registeredToolNames } = createToolRegistrar({
    server,
    clientFactory,
    securitySchemes,
    authChallenge,
    readOnly,
    outputSchema,
    observabilityObserver,
    observabilityToolScope,
    deploymentMode,
  });
  const toolsetSelection = resolveToolsetSelection(toolsets);
  const {
    assignments,
    platformRegistrar,
    registrar: toolForToolset,
  } = createToolsetRegistrationRouter({
    tool,
    selection: toolsetSelection,
  });

  registerRuntimeTools(toolForToolset("context"), {
    registeredToolNames,
    readOnly,
    deploymentMode,
    buildId,
    distributionMetadata,
  });

  registerPlatformTools(platformRegistrar);
  registerIssueTools(toolForToolset("issues"));
  registerMergeRequestTools(toolForToolset("merge_requests"));
  registerRepositoryTools(toolForToolset("repository"));
  registerPipelineTools(toolForToolset("ci"));
  registerGovernanceTools(toolForToolset("governance"));
  registerReleaseTools(toolForToolset("releases"));
  registerPipelineScheduleTools(toolForToolset("ci"));
  registerCiVariableTools(toolForToolset("variables"));
  registerProjectAccessTokenTools(toolForToolset("governance"));
  registerDeploymentTools(toolForToolset("deployments"));
  registerWebhookTools(toolForToolset("webhooks"));

  if (typeof registeredToolObserver === "function") {
    registeredToolObserver(Object.freeze([...registeredToolNames]));
  }
  if (typeof registeredToolsetObserver === "function") {
    registeredToolsetObserver(
      frozenToolsetAssignments(assignments),
      toolsetSelection,
    );
  }
}

export { gitLabToolAnnotations } from "./annotations.mjs";
