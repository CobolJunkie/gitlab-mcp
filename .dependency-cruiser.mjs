import { createDependencyCruiserForbiddenRules } from "./.dependency-cruiser-rules.mjs";

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: createDependencyCruiserForbiddenRules({
    paths: {
      production: "^(server/src|scripts|skills|shared|adapters)(?:/|$)",
      tests: "^(server/test|test|test-dependency-boundaries)/",
      core: "^server/",
      shared: "^(skills/|shared/)",
      adapters: "^adapters/",
      coreInternals: "^server/",
      platformInternals: "^server/src/tools/platform/",
      platformComposition: String.raw`^server/src/tools/platform-tools\.mjs$`,
      repositoryInternals: "^server/src/tools/repository/",
      repositoryComposition: "^server/src/tools/repository-tools\\.mjs$",
      mergeRequestInternals: "^server/src/tools/merge-request/",
      mergeRequestComposition: "^server/src/tools/merge-request-tools\\.mjs$",
      httpInternals: "^server/src/http/",
      httpFacade: "^server/src/http\\.mjs$",
      httpFoundations:
        "^server/src/http/(?:policy|admission|auth|readiness)\\.mjs$",
      httpComposition: "^server/src/http/(?:app|lifecycle)\\.mjs$",
    },
    adaptersDirectory: new URL("./adapters/", import.meta.url),
    tolerateMissingAdapters: true,
  }),
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".mjs", ".js", ".cjs", ".json", ".node"],
    },
    cache: false,
  },
};
