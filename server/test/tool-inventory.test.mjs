import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGitLabMcpServer } from "../src/server.mjs";

const contracts = JSON.parse(
  await readFile(
    new URL("../../docs/gitlab-tool-contracts.json", import.meta.url),
    "utf8",
  ),
);

const STRING_SAMPLES = {
  project: "group/project",
  group: "parent/team",
  path: "src/app.js",
  file_path: "src/app.js",
  previous_path: "src/old.js",
  artifact_path: "reports/result.json",
  branch: "codex/contract",
  source_branch: "codex/source",
  target_branch: "main",
  start_branch: "main",
  ref: "main",
  from: "main",
  to: "next",
  sha: "abcdef123456",
  blob_sha: "abcdef123456",
  search: "contract",
  title: "Contract title",
  body: "Contract body",
  description: "Contract description",
  content: "contract content",
  commit_message: "test: contract",
  merge_commit_message: "Merge contract",
  squash_commit_message: "Squash contract",
  discussion_id: "discussion-1",
  author_email: "contract@example.com",
  author_name: "Contract Test",
  key: "CONTRACT_KEY",
  value: "contract-value",
  name: "thumbsup",
};

function sampleString(name, schema) {
  if (schema.format === "email") {
    return "contract@example.com";
  }
  if (schema.format === "date") {
    return "2026-07-27";
  }
  if (schema.format === "date-time") {
    return "2026-07-27T12:00:00Z";
  }
  if (schema.format === "uri" || schema.format === "url") {
    return "https://gitlab.example.com/group/project/-/blob/main/README.md";
  }
  return STRING_SAMPLES[name] || `${name || "value"}-contract`;
}

function sampleValue(schema, name) {
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (schema.enum) {
    return schema.enum[0];
  }
  if (schema.oneOf) {
    return sampleValue(schema.oneOf[0], name);
  }
  if (schema.anyOf) {
    const candidate = schema.anyOf.find((item) => item.type !== "null");
    return sampleValue(candidate || schema.anyOf[0], name);
  }
  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [
        key,
        sampleValue(value, key),
      ]),
    );
  }
  if (schema.type === "array") {
    return [sampleValue(schema.items || { type: "string" }, name)];
  }
  if (schema.type === "boolean") {
    return true;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum !== undefined) {
      return schema.minimum;
    }
    if (schema.exclusiveMinimum !== undefined) {
      return schema.exclusiveMinimum + 1;
    }
    return 7;
  }
  if (schema.type === "null") {
    return null;
  }
  return sampleString(name, schema);
}

function argumentsFor(tool) {
  const args = sampleValue(tool.inputSchema, tool.name);
  if (tool.name === "search_gitlab") {
    delete args.group;
  }
  if (tool.name === "fetch_gitlab_file_url") {
    args.url = "https://gitlab.example.com/group/project/-/blob/main/README.md";
  }
  if (tool.name === "download_gitlab_attachment") {
    args.url =
      "https://gitlab.example.com/group/project/-/uploads/hash/file.txt";
  }
  if (tool.name === "create_commit") {
    delete args.start_branch;
    args.start_sha = "a".repeat(40);
    for (const action of args.actions || []) {
      if (action && action.action !== "create") {
        action.last_commit_id = "last-commit-id";
      }
    }
  }
  if (tool.name === "create_destructive_commit") {
    delete args.force;
    args.start_sha = "a".repeat(40);
  }
  if (
    tool.name === "apply_merge_request_suggestion" ||
    tool.name === "batch_apply_merge_request_suggestions"
  ) {
    args.expected_head_sha = "contract-head-sha-000000000000000000000000";
  }
  return args;
}

function safetyFor(tool) {
  if (tool.annotations.destructiveHint) {
    return "destructive";
  }
  return tool.annotations.readOnlyHint ? "read" : "write";
}

function normalizedCall(path, options = {}) {
  return {
    method: options.method || "GET",
    path: path instanceof URL ? path.toString() : path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.responseType ? { responseType: options.responseType } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  };
}

function callSignature(call) {
  return [
    `${call.method} ${call.path}`,
    call.query ? `query=${JSON.stringify(call.query)}` : undefined,
    call.body ? `body=${JSON.stringify(call.body)}` : undefined,
    call.responseType ? `responseType=${call.responseType}` : undefined,
    call.maxBytes ? `maxBytes=${call.maxBytes}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function responseFor(path, options = {}) {
  const route = String(path);
  if (route === "/user") {
    return { data: { id: 7, username: "contract-user" } };
  }
  if (route === "/version" || route === "/metadata") {
    return { data: { version: "18.2.0", revision: "contract" } };
  }
  if (route.includes("/merge_requests/") && route.endsWith("/discussions")) {
    return {
      data: [
        {
          id: "disc-contract",
          individual_note: false,
          notes: [
            {
              id: 1,
              type: "DiffNote",
              body: "contract",
              system: false,
              noteable_id: 1,
              noteable_type: "MergeRequest",
              project_id: 12,
              suggestions: [
                {
                  id: 1,
                  from_line: 10,
                  to_line: 10,
                  appliable: true,
                  applied: false,
                  from_content: "old",
                  to_content: "new",
                },
              ],
            },
          ],
        },
      ],
    };
  }
  // Exact MR metadata route (e.g., /projects/group%2Fproject/merge_requests/1)
  if (/\/merge_requests\/\d+$/.test(route)) {
    return {
      data: {
        diff_refs: {
          head_sha: "contract-head-sha-000000000000000000000000",
          base_sha: "contract-base",
          start_sha: "contract-start",
        },
      },
    };
  }
  if (route.includes("/repository/branches/")) {
    return { data: { commit: { id: "a".repeat(40) } } };
  }
  if (route.includes("/personal_access_tokens/self")) {
    return { data: { active: true, scopes: ["api"] } };
  }
  if (/\/merge_requests\/\d+\/diffs$/.test(route)) {
    return {
      data: [
        {
          old_path: "src/app.js",
          new_path: "src/app.js",
          diff: "@@ -1 +1 @@",
        },
      ],
      pagination: {},
    };
  }
  if (
    options.responseType === "text" ||
    route.includes("/repository/files/") ||
    route.includes("/repository/blobs/")
  ) {
    if (options.responseType === "text") {
      return { data: "one\ntwo\nthree\n" };
    }
    return {
      data: {
        encoding: "base64",
        content: Buffer.from("one\ntwo\nthree\n").toString("base64"),
      },
    };
  }
  if (options.responseType === "binary") {
    return {
      data: {
        encoding: "base64",
        contentType: "application/octet-stream",
        contentLength: 8,
        content: Buffer.from("contract").toString("base64"),
      },
    };
  }
  if (/\/hooks\/\d+\/events$/.test(route)) {
    return {
      data: [
        {
          id: options.query?.per_page ? 1 : 7,
          trigger: "push_hooks",
          url: "https://example.com/hook",
          response_status: "200",
          request_headers: { "content-type": "application/json" },
          response_body: "OK",
          execution_duration: 1.5,
        },
      ],
      pagination: {},
    };
  }
  if (
    route.includes("/variables/") &&
    options.query?.["filter[environment_scope]"]
  ) {
    return {
      data: {
        key: "CONTRACT_KEY",
        environment_scope: options.query["filter[environment_scope]"],
      },
    };
  }
  return {
    data: {
      id: 7,
      iid: 7,
      name: "contract",
      username: "contract-user",
    },
    pagination: {},
  };
}

test("invokes every registered tool against its explicit route and safety contract", async (t) => {
  const calls = [];
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createGitLabMcpServer({
    clientFactory: () => ({
      baseUrl: "https://gitlab.example.com",
      token: "contract-token",
      request: async (path, options) => {
        calls.push(normalizedCall(path, options));
        return responseFor(path, options);
      },
    }),
  });
  const client = new Client({ name: "inventory-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const actual = {};
  for (const tool of listed.tools) {
    for (const annotation of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      assert.equal(
        typeof tool.annotations[annotation],
        "boolean",
        `${tool.name} must explicitly classify ${annotation}`,
      );
    }
    const properties = tool.inputSchema.properties || {};
    if (properties.page) {
      assert.equal(properties.page.minimum, 1, `${tool.name}.page minimum`);
    }
    if (properties.per_page) {
      assert.equal(
        properties.per_page.minimum,
        1,
        `${tool.name}.per_page minimum`,
      );
      assert.equal(
        properties.per_page.maximum,
        100,
        `${tool.name}.per_page maximum`,
      );
    }
    calls.length = 0;
    const result = await client.callTool({
      name: tool.name,
      arguments: argumentsFor(tool),
    });
    assert.equal(
      result.isError,
      undefined,
      `${tool.name} did not complete its contract invocation: ${result.content?.[0]?.text}`,
    );
    actual[tool.name] = [
      safetyFor(tool),
      ...calls.map((call) => callSignature(call)),
    ];
  }

  if (process.env.PRINT_TOOL_CONTRACTS === "true") {
    console.log(JSON.stringify(actual, null, 2));
    return;
  }
  assert.deepEqual(actual, contracts);
});
