import { createDependencyCruiserForbiddenRules } from "../.dependency-cruiser-rules.mjs";

const ROOT = "test-dependency-boundaries";

export default {
  forbidden: createDependencyCruiserForbiddenRules({
    paths: {
      production: `^${ROOT}/production/`,
      tests: `^${ROOT}/fixtures/`,
      core: `^${ROOT}/core/`,
      shared: `^${ROOT}/(skills|shared)/`,
      adapters: `^${ROOT}/adapters/`,
      coreInternals: `^${ROOT}/core/`,
      platformInternals: `^${ROOT}/platform/internal/`,
      platformComposition: `^${ROOT}/platform/composition\\.mjs$`,
      repositoryInternals: `^${ROOT}/repository/internal/`,
      repositoryComposition: `^${ROOT}/repository/composition\\.mjs$`,
      mergeRequestInternals: `^${ROOT}/merge-request/internal/`,
      mergeRequestComposition: `^${ROOT}/merge-request/composition\\.mjs$`,
      httpInternals: `^${ROOT}/http/internal/`,
      httpFacade: `^${ROOT}/http/facade\\.mjs$`,
      httpFoundations: `^${ROOT}/http/foundations/`,
      httpComposition: `^${ROOT}/http/composition/`,
    },
    // Use the production adapter set so fixture isolation rules track production.
    adaptersDirectory: new URL("../adapters/", import.meta.url),
  }),
  options: {
    doNotFollow: { path: "node_modules" },
    cache: false,
  },
};
