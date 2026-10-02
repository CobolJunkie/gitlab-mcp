import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupDeploymentFixture,
  createDeploymentFixture,
} from "../scripts/lib/workload-live-deployment-fixtures.mjs";

function sessionFixture(resolver = () => undefined) {
  const calls = [];
  return {
    project: 42,
    defaultBranch: "main",
    calls,
    async call(name, args = {}) {
      calls.push({ name, args });
      return resolver(name, args, calls);
    },
    async cleanupBenchmarkEnvironment(args) {
      calls.push({ name: "cleanupBenchmarkEnvironment", args });
      return resolver("cleanupBenchmarkEnvironment", args, calls);
    },
  };
}

function callsNamed(session, name) {
  return session.calls.filter((entry) => entry.name === name);
}

function successfulResolver(name, args) {
  if (name === "create_commit") return { id: "deployment-sha" };
  if (name === "list_pipelines") {
    return { id: 61, sha: "deployment-sha", status: "pending" };
  }
  if (name === "get_pipeline") return { id: 61, status: "success" };
  if (name === "list_environments") {
    return { data: [{ id: 71, name: args.search, state: "available" }] };
  }
  if (name === "list_deployments") {
    return {
      data: [
        {
          id: 81,
          status: "success",
          ref: args.ref,
          sha: "deployment-sha",
          environment: { id: 71, name: args.environment },
        },
      ],
    };
  }
  if (name === "list_branches") {
    return {
      data: [{ name: args.search, commit: { id: "deployment-sha" } }],
    };
  }
  return undefined;
}

test("deployment fixture resolves one exact benchmark environment and deployment", async () => {
  const session = sessionFixture(successfulResolver);
  const fixture = await createDeploymentFixture(session, {
    label: "deployment-inspect",
    environmentName: "benchmark / deployment-inspect",
    ciYaml: "stages: [deploy]\n",
  });

  assert.equal(fixture.environment.id, 71);
  assert.equal(fixture.deployment.id, 81);
  assert.equal(fixture.environmentName, "benchmark / deployment-inspect");
  assert.equal(fixture.pipelineFixture.pipeline.id, 61);
});

test("deployment cleanup removes proven environment and pipeline-owned branch", async () => {
  const session = sessionFixture(successfulResolver);
  await cleanupDeploymentFixture(session, {
    environmentName: "benchmark / deployment-inspect",
    environment: { id: 71 },
    deployment: { id: 81 },
    pipelineFixture: {
      branch: "mcp-bench/deployment-inspect",
      branchCreated: true,
      pipeline: { id: 61 },
    },
  });

  assert.deepEqual(callsNamed(session, "cleanupBenchmarkEnvironment")[0].args, {
    environmentId: 71,
    environmentName: "benchmark / deployment-inspect",
  });
  assert.equal(callsNamed(session, "delete_branch").length, 1);
});

test("deployment cleanup still removes the branch when environment cleanup fails", async () => {
  const failure = new Error("environment cleanup failed");
  const session = sessionFixture((name, args) => {
    if (name === "cleanupBenchmarkEnvironment") throw failure;
    if (name === "get_pipeline") return { id: 61, status: "success" };
    if (name === "list_branches") return { data: [{ name: args.search }] };
    return undefined;
  });

  await assert.rejects(
    cleanupDeploymentFixture(session, {
      environmentName: "benchmark / deployment-inspect",
      environment: { id: 71 },
      deployment: { id: 81 },
      pipelineFixture: {
        branch: "mcp-bench/deployment-inspect",
        branchCreated: true,
        pipeline: { id: 61 },
      },
    }),
    (error) => error === failure,
  );
  assert.equal(callsNamed(session, "delete_branch").length, 1);
});

test("deployment setup refuses an environment without matching deployment provenance", async () => {
  const session = sessionFixture((name, args) => {
    if (name === "create_commit") return { id: "deployment-sha" };
    if (name === "list_pipelines") {
      return { id: 61, sha: "deployment-sha", status: "pending" };
    }
    if (name === "get_pipeline") return { id: 61, status: "success" };
    if (name === "list_environments") {
      return { data: [{ id: 71, name: args.search, state: "available" }] };
    }
    if (name === "list_deployments") {
      return {
        data: [
          {
            id: 82,
            status: "success",
            ref: args.ref,
            sha: "different-sha",
            environment: { id: 71, name: args.environment },
          },
        ],
      };
    }
    if (name === "list_branches") {
      return {
        data: [{ name: args.search, commit: { id: "deployment-sha" } }],
      };
    }
    return undefined;
  });

  await assert.rejects(
    createDeploymentFixture(session, {
      label: "unowned-deployment",
      environmentName: "benchmark / unowned-deployment",
      ciYaml: "stages: [deploy]\n",
    }),
    /exactly one successful benchmark deployment/,
  );
  assert.equal(callsNamed(session, "cleanupBenchmarkEnvironment").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 1);
});

test("deployment setup refuses ambiguous exact-name environments and cleans the pipeline", async () => {
  const session = sessionFixture((name, args) => {
    if (name === "create_commit") return { id: "deployment-sha" };
    if (name === "list_pipelines") {
      return { id: 61, sha: "deployment-sha", status: "pending" };
    }
    if (name === "get_pipeline") return { id: 61, status: "success" };
    if (name === "list_environments") {
      return {
        data: [
          { id: 71, name: args.search },
          { id: 72, name: args.search },
        ],
      };
    }
    if (name === "list_branches") {
      return {
        data: [{ name: args.search, commit: { id: "deployment-sha" } }],
      };
    }
    return undefined;
  });

  await assert.rejects(
    createDeploymentFixture(session, {
      label: "ambiguous-deployment",
      environmentName: "benchmark / ambiguous-deployment",
      ciYaml: "stages: [deploy]\n",
    }),
    /exactly one benchmark environment/,
  );
  assert.equal(callsNamed(session, "cleanupBenchmarkEnvironment").length, 0);
  assert.equal(callsNamed(session, "delete_branch").length, 1);
});
