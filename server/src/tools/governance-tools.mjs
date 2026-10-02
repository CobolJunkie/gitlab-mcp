/**
 * Governance tools for the GitLab MCP server.
 *
 * Protected-branch inspection/management and project approval-rule tools
 * that enforce capability preflights, acknowledgement requirements, and
 * read-before-write safety.  Extracted from `tools.mjs` without any
 * policy or semantic changes.
 *
 * Exports a single registration function consumed by `registerGitLabTools`
 * so that tool names, schemas, annotations, and handler logic remain
 * identical while living in a dedicated module.
 */

import * as z from "zod/v4";

import { getGitLabCapabilities } from "../capabilities.mjs";
import { encodePathSegment } from "../gitlab-client.mjs";

import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.mjs";
import { project, nonEmpty } from "./schemas.mjs";
import { p } from "./paths.mjs";
import { cleanBody } from "./responses.mjs";

/**
 * Register governance tools (protected branches, protected tags, and project
 * approval rules).
 *
 * @param {Function} tool - The registrar function from `createToolRegistrar`.
 */
export function registerGovernanceTools(tool) {
  // ── Protected-branch schemas / helpers ───────────────────────────────

  const branchAccessLevel = z.union([
    z.literal(0),
    z.literal(30),
    z.literal(40),
    z.literal(60),
  ]);
  const branchUnprotectAccessLevel = z.union([
    z.literal(30),
    z.literal(40),
    z.literal(60),
  ]);
  const accessSelectorSchemas = (
    accessLevel,
    { allowDeployKey = false, includeRecordId = false } = {},
  ) => {
    const recordId = includeRecordId
      ? { id: z.number().int().positive().optional() }
      : {};
    return [
      z.object({ ...recordId, access_level: accessLevel }).strict(),
      z
        .object({
          ...recordId,
          user_id: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          ...recordId,
          group_id: z.number().int().positive(),
        })
        .strict(),
      ...(allowDeployKey
        ? [
            z
              .object({
                ...recordId,
                deploy_key_id: z.number().int().positive(),
              })
              .strict(),
          ]
        : []),
    ];
  };
  const accessRule = (accessLevel, { allowDeployKey = false } = {}) =>
    z.union(accessSelectorSchemas(accessLevel, { allowDeployKey }));
  const protectedBranchPushAccess = accessRule(branchAccessLevel, {
    allowDeployKey: true,
  });
  const protectedBranchMergeAccess = accessRule(branchAccessLevel);
  const protectedBranchUnprotectAccess = accessRule(branchUnprotectAccessLevel);
  const protectedBranchAccessList = (schema) =>
    z.array(schema).max(20).optional();

  const accessMutation = (accessLevel, { allowDeployKey = false } = {}) =>
    z.union([
      ...accessSelectorSchemas(accessLevel, {
        allowDeployKey,
        includeRecordId: true,
      }),
      z
        .object({
          id: z.number().int().positive(),
          _destroy: z.literal(true),
        })
        .strict(),
    ]);
  const protectedBranchPushMutation = accessMutation(branchAccessLevel, {
    allowDeployKey: true,
  });
  const protectedBranchMergeMutation = accessMutation(branchAccessLevel);
  const protectedBranchUnprotectMutation = accessMutation(
    branchUnprotectAccessLevel,
  );
  const protectedBranchAccessMutationList = (schema) =>
    z.array(schema).min(1).max(20).optional();
  // Each access rule must reach GitLab as one object. Flattening rules into
  // repeated `allowed_to_push[][field]` query keys transposes them into
  // per-field parallel arrays, and Rack then merges rules that do not share a
  // field into a single rule: `[{access_level:30},{user_id:77}]` arrived as one
  // `{access_level:30, user_id:77}` rule. Send the arrays in a JSON body so the
  // rule boundaries survive.
  const protectedBranchAccessRules = (entries) =>
    entries?.map((entry) => cleanBody(entry));
  const protectedBranchBody = (args, { includeName = true } = {}) =>
    cleanBody({
      ...(includeName ? { name: args.name } : {}),
      allow_force_push: args.allow_force_push,
      code_owner_approval_required: args.code_owner_approval_required,
      allowed_to_push: protectedBranchAccessRules(args.allowed_to_push),
      allowed_to_merge: protectedBranchAccessRules(args.allowed_to_merge),
      allowed_to_unprotect: protectedBranchAccessRules(
        args.allowed_to_unprotect,
      ),
    });
  const validateProtectedBranchAccessMutations = (
    entries,
    currentEntries,
    label,
    { requireRemaining = false } = {},
  ) => {
    if (entries === undefined) {
      return;
    }
    const current = Array.isArray(currentEntries) ? currentEntries : [];
    const currentIds = new Set(
      current
        .map((entry) => entry?.id)
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const referencedIds = new Set();
    let remaining = currentIds.size;

    for (const entry of entries) {
      if (entry.id === undefined) {
        remaining += 1;
        continue;
      }
      if (referencedIds.has(entry.id)) {
        throw new Error(
          `${label} access record ${entry.id} is referenced more than once.`,
        );
      }
      referencedIds.add(entry.id);
      if (!currentIds.has(entry.id)) {
        throw new Error(
          `${label} access record ${entry.id} does not exist on the protected branch.`,
        );
      }
      if (entry._destroy === true) {
        remaining -= 1;
      }
    }

    if (requireRemaining && remaining < 1) {
      throw new Error(
        "Protected branch updates must preserve at least one unprotect access rule.",
      );
    }
  };
  const validateProtectedBranchUpdate = (args, current) => {
    validateProtectedBranchAccessMutations(
      args.allowed_to_push,
      current?.push_access_levels,
      "Push",
    );
    validateProtectedBranchAccessMutations(
      args.allowed_to_merge,
      current?.merge_access_levels,
      "Merge",
    );
    validateProtectedBranchAccessMutations(
      args.allowed_to_unprotect,
      current?.unprotect_access_levels,
      "Unprotect",
      { requireRemaining: true },
    );
  };
  const requireProjectCapability = async (client, projectValue, name) => {
    const evidence = await getGitLabCapabilities(client, {
      project: projectValue,
    });
    const capability = evidence.capabilities?.[name];
    if (capability?.state !== "available") {
      throw new Error(
        `${name} is not available for this project: ${capability?.reason || "GitLab did not provide usable capability evidence."}`,
      );
    }
  };

  // ── Protected-branch tools ──────────────────────────────────────────

  tool(
    "list_protected_branches",
    {
      title: "List protected branches",
      description:
        "Inspect protected-branch access policy for a GitLab project.",
      inputSchema: {
        project,
        search: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/protected_branches`, { query });
    },
  );

  tool(
    "get_protected_branch",
    {
      title: "Get protected branch",
      description:
        "Inspect one protected branch and its push, merge, unprotect, and code-owner approval policy.",
      inputSchema: {
        project,
        name: nonEmpty,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/protected_branches/${encodePathSegment(args.name)}`,
        )
      ).data,
  );

  tool(
    "protect_branch",
    {
      title: "Protect branch",
      description:
        "Create protected-branch policy after a capability preflight. An explicit acknowledgement and unprotect rule are required to avoid accidental lockout.",
      inputSchema: {
        project,
        name: nonEmpty,
        allowed_to_push: protectedBranchAccessList(protectedBranchPushAccess),
        allowed_to_merge: protectedBranchAccessList(protectedBranchMergeAccess),
        allowed_to_unprotect: z
          .array(protectedBranchUnprotectAccess)
          .min(1)
          .max(20),
        allow_force_push: z.boolean().optional(),
        code_owner_approval_required: z.boolean().optional(),
        acknowledge_protection_change: z.literal(true),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireProjectCapability(
        client,
        args.project,
        "protected_branches",
      );
      const base = `${p(args.project)}/protected_branches`;
      await client.request(base, {
        query: { search: args.name, per_page: 1 },
      });
      return (
        await client.request(base, {
          method: "POST",
          body: protectedBranchBody(args),
        })
      ).data;
    },
  );

  tool(
    "update_protected_branch",
    {
      title: "Update protected branch",
      description:
        "Update protected-branch policy after reading the current policy. Existing access records are addressed by record id and removed with _destroy=true; omitted access lists remain unchanged. Explicit acknowledgement is required.",
      inputSchema: {
        project,
        name: nonEmpty,
        allowed_to_push: protectedBranchAccessMutationList(
          protectedBranchPushMutation,
        ),
        allowed_to_merge: protectedBranchAccessMutationList(
          protectedBranchMergeMutation,
        ),
        allowed_to_unprotect: protectedBranchAccessMutationList(
          protectedBranchUnprotectMutation,
        ),
        allow_force_push: z.boolean().optional(),
        code_owner_approval_required: z.boolean().optional(),
        acknowledge_protection_change: z.literal(true),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      const body = protectedBranchBody(args, { includeName: false });
      if (Object.keys(body).length === 0) {
        throw new Error(
          "At least one protected-branch policy change is required.",
        );
      }
      await requireProjectCapability(
        client,
        args.project,
        "protected_branches",
      );
      const base = `${p(args.project)}/protected_branches/${encodePathSegment(args.name)}`;
      const current = (await client.request(base)).data;
      validateProtectedBranchUpdate(args, current);
      return (
        await client.request(base, {
          method: "PATCH",
          body,
        })
      ).data;
    },
  );

  tool(
    "unprotect_branch",
    {
      title: "Unprotect branch",
      description:
        "Remove protected-branch policy only after reading the current policy and explicitly acknowledging the destructive governance change.",
      inputSchema: {
        project,
        name: nonEmpty,
        acknowledge_protection_change: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      await requireProjectCapability(
        client,
        args.project,
        "protected_branches",
      );
      const base = `${p(args.project)}/protected_branches/${encodePathSegment(args.name)}`;
      await client.request(base);
      return (await client.request(base, { method: "DELETE" })).data;
    },
  );

  // ── Protected-tag tools ─────────────────────────────────────────────

  const tagAccessLevel = z.union([z.literal(0), z.literal(30), z.literal(40)]);
  const tagCreateAccess = accessRule(tagAccessLevel, {
    allowDeployKey: true,
  });
  const tagCreateAccessList = z.array(tagCreateAccess).max(20).optional();
  const tagCreateAccessRules = (entries) =>
    entries?.map((entry) => cleanBody(entry));

  tool(
    "list_protected_tags",
    {
      title: "List protected tags",
      description:
        "Inspect protected-tag create-access policy for a GitLab project.",
      inputSchema: {
        project,
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) => {
      const { project: projectValue, ...query } = args;
      return client.request(`${p(projectValue)}/protected_tags`, { query });
    },
  );

  tool(
    "get_protected_tag",
    {
      title: "Get protected tag",
      description: "Inspect one protected tag and its create-access policy.",
      inputSchema: {
        project,
        name: nonEmpty,
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/protected_tags/${encodePathSegment(args.name)}`,
        )
      ).data,
  );

  tool(
    "protect_tag",
    {
      title: "Protect tag",
      description:
        "Create a protected-tag policy after a capability preflight. An explicit acknowledgement is required to prevent accidental governance changes.",
      inputSchema: {
        project,
        name: nonEmpty,
        create_access_level: tagAccessLevel.optional(),
        allowed_to_create: tagCreateAccessList,
        acknowledge_protection_change: z.literal(true),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireProjectCapability(client, args.project, "protected_tags");
      const base = `${p(args.project)}/protected_tags`;
      return (
        await client.request(base, {
          method: "POST",
          body: cleanBody({
            name: args.name,
            create_access_level: args.create_access_level,
            allowed_to_create: tagCreateAccessRules(args.allowed_to_create),
          }),
        })
      ).data;
    },
  );

  tool(
    "unprotect_tag",
    {
      title: "Unprotect tag",
      description:
        "Remove a protected-tag policy only after reading the current policy and explicitly acknowledging the destructive governance change.",
      inputSchema: {
        project,
        name: nonEmpty,
        acknowledge_protection_change: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      await requireProjectCapability(client, args.project, "protected_tags");
      const base = `${p(args.project)}/protected_tags/${encodePathSegment(args.name)}`;
      await client.request(base);
      return (await client.request(base, { method: "DELETE" })).data;
    },
  );

  // ── Project approval-rule tools ─────────────────────────────────────

  tool(
    "list_project_approval_rules",
    {
      title: "List project approval rules",
      description:
        "List project-level merge-request approval rules and eligible approvers.",
      inputSchema: { project },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (await client.request(`${p(args.project)}/approval_rules`)).data,
  );

  tool(
    "get_project_approval_rule",
    {
      title: "Get project approval rule",
      description: "Get one project-level merge-request approval rule by ID.",
      inputSchema: {
        project,
        approval_rule_id: z.number().int().positive(),
      },
      annotations: READ_ONLY,
    },
    async (client, args) =>
      (
        await client.request(
          `${p(args.project)}/approval_rules/${args.approval_rule_id}`,
        )
      ).data,
  );

  const approvalRuleFields = {
    name: nonEmpty,
    approvals_required: z.number().int().min(0).max(100),
    applies_to_all_protected_branches: z.boolean().optional(),
    group_ids: z.array(z.number().int().positive()).max(100).optional(),
    user_ids: z.array(z.number().int().positive()).max(100).optional(),
    protected_branch_ids: z
      .array(z.number().int().positive())
      .max(100)
      .optional(),
    report_type: z
      .enum([
        "code_coverage",
        "license_scanning",
        "security_scan",
        "sast",
        "dependency_scanning",
        "container_scanning",
        "dast",
        "secret_detection",
      ])
      .optional(),
  };

  tool(
    "create_project_approval_rule",
    {
      title: "Create project approval rule",
      description:
        "Create a merge-request approval rule after a capability preflight. The explicit acknowledgement prevents accidental governance changes.",
      inputSchema: {
        project,
        ...approvalRuleFields,
        acknowledge_policy_change: z.literal(true),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireProjectCapability(
        client,
        args.project,
        "project_approval_rules",
      );
      const base = `${p(args.project)}/approval_rules`;
      await client.request(base, { query: { per_page: 1 } });
      const { project: projectValue, ...body } = args;
      delete body.acknowledge_policy_change;
      return (
        await client.request(`${p(projectValue)}/approval_rules`, {
          method: "POST",
          body,
        })
      ).data;
    },
  );

  tool(
    "update_project_approval_rule",
    {
      title: "Update project approval rule",
      description:
        "Update a project approval rule only after reading the current rule and explicitly acknowledging the governance change.",
      inputSchema: {
        project,
        approval_rule_id: z.number().int().positive(),
        ...Object.fromEntries(
          Object.entries(approvalRuleFields).filter(([key]) => key !== "name"),
        ),
        name: z.string().min(1).optional(),
        acknowledge_policy_change: z.literal(true),
      },
      annotations: WRITE,
    },
    async (client, args) => {
      await requireProjectCapability(
        client,
        args.project,
        "project_approval_rules",
      );
      const base = `${p(args.project)}/approval_rules/${args.approval_rule_id}`;
      await client.request(base);
      const { project: projectValue, approval_rule_id, ...body } = args;
      delete body.acknowledge_policy_change;
      return (
        await client.request(
          `${p(projectValue)}/approval_rules/${approval_rule_id}`,
          {
            method: "PUT",
            body: cleanBody(body),
          },
        )
      ).data;
    },
  );

  tool(
    "delete_project_approval_rule",
    {
      title: "Delete project approval rule",
      description:
        "Delete a project approval rule only after reading it and explicitly acknowledging the destructive governance change.",
      inputSchema: {
        project,
        approval_rule_id: z.number().int().positive(),
        acknowledge_policy_change: z.literal(true),
      },
      annotations: DESTRUCTIVE,
    },
    async (client, args) => {
      await requireProjectCapability(
        client,
        args.project,
        "project_approval_rules",
      );
      const base = `${p(args.project)}/approval_rules/${args.approval_rule_id}`;
      await client.request(base);
      return (await client.request(base, { method: "DELETE" })).data;
    },
  );
}
