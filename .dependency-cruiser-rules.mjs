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
  const { production, tests, core, shared, adapters, coreInternals } = paths;

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
    ...isolationRules,
  ];
}
