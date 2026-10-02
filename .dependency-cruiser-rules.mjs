import { readdirSync } from "node:fs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function adapterNames(adaptersDirectory, tolerateMissingAdapters) {
  try {
    return readdirSync(adaptersDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (tolerateMissingAdapters && error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createDependencyCruiserForbiddenRules({
  paths,
  adaptersDirectory,
  tolerateMissingAdapters = false,
}) {
  const {
    production,
    tests,
    core,
    shared,
    adapters,
    coreInternals,
    platformInternals,
    platformComposition,
    repositoryInternals,
    repositoryComposition,
    mergeRequestInternals,
    mergeRequestComposition,
    httpInternals,
    httpFacade,
    httpFoundations,
    httpComposition,
  } = paths;

  const isolationRules = adapterNames(
    adaptersDirectory,
    tolerateMissingAdapters,
  ).map((adapterName) => {
    const escaped = escapeRegExp(adapterName);
    return {
      name: `no-${adapterName}-adapter-depends-on-other-adapters`,
      severity: "error",
      comment: `${adapterName} adapter must not depend on another harness adapter.`,
      from: { path: `${adapters}${escaped}/` },
      to: {
        path: adapters,
        pathNot: `${adapters}${escaped}/`,
      },
    };
  });

  return [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies make modules hard to reason about, test, and replace.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved",
      severity: "error",
      comment: "Unresolved imports cause runtime failures.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-production-on-test",
      severity: "error",
      comment: "Production code must not depend on tests or test fixtures.",
      from: { path: production },
      to: { path: tests },
    },
    {
      name: "no-core-depends-on-adapters",
      severity: "error",
      comment: "MCP core/server must never depend on harness adapters.",
      from: { path: core },
      to: { path: adapters },
    },
    {
      name: "no-shared-depends-on-adapters",
      severity: "error",
      comment:
        "Shared code and canonical skills must not import harness adapters.",
      from: { path: shared },
      to: { path: adapters },
    },
    {
      name: "no-adapter-depends-on-core-internals",
      severity: "error",
      comment: "Adapters depend on shared public seams, not server internals.",
      from: { path: adapters },
      to: { path: coreInternals },
    },
    {
      name: "no-platform-internals-depend-on-composition",
      severity: "error",
      comment:
        "Platform internals are downstream of the stable platform registration boundary.",
      from: { path: platformInternals },
      to: { path: platformComposition },
    },
    {
      name: "no-repository-internals-depend-on-composition",
      severity: "error",
      comment:
        "Repository workflow internals are downstream of the stable repository registration boundary.",
      from: { path: repositoryInternals },
      to: { path: repositoryComposition },
    },
    {
      name: "no-merge-request-internals-depend-on-composition",
      severity: "error",
      comment:
        "Merge-request workflow internals are downstream of the stable merge-request registration boundary.",
      from: { path: mergeRequestInternals },
      to: { path: mergeRequestComposition },
    },
    {
      name: "no-http-internals-depend-on-public-facade",
      severity: "error",
      comment:
        "HTTP internals implement the public compatibility facade and must not import back through it.",
      from: { path: httpInternals },
      to: { path: httpFacade },
    },
    {
      name: "no-http-foundations-depend-on-composition",
      severity: "error",
      comment:
        "Lower-level HTTP policy, admission, auth, and readiness modules must not depend on app or lifecycle composition.",
      from: { path: httpFoundations },
      to: { path: httpComposition },
    },
    ...isolationRules,
  ];
}
