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
