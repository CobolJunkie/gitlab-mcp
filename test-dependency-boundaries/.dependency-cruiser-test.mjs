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
    },
    // Use the production adapter set so fixture isolation rules track production.
    adaptersDirectory: new URL("../adapters/", import.meta.url),
  }),
  options: {
    doNotFollow: { path: "node_modules" },
    cache: false,
  },
};
