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
import { registerDeploymentTools } from "./deployment-tools.mjs";
import { registerWebhookTools } from "./webhook-tools.mjs";

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
    deploymentMode,
  });

  registerRuntimeTools(tool, {
    registeredToolNames,
    readOnly,
    deploymentMode,
    buildId,
    distributionMetadata,
  });

  registerPlatformTools(tool);
  registerIssueTools(tool);
  registerMergeRequestTools(tool);
  registerRepositoryTools(tool);
  registerPipelineTools(tool);
  registerGovernanceTools(tool);
  registerReleaseTools(tool);
  registerPipelineScheduleTools(tool);
  registerCiVariableTools(tool);
  registerDeploymentTools(tool);
  registerWebhookTools(tool);
}

export { gitLabToolAnnotations } from "./annotations.mjs";
