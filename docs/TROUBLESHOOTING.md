# Troubleshooting

Start with the symptom, perform the smallest diagnostic, and avoid posting
tokens or private GitLab content in an issue.

## Distribution, Skills, or tools are missing

Possible causes:

- the selected harness distribution is not installed or enabled;
- harness MCP/package configuration points at a stale or incomplete package;
- the session started before installation or upgrade;
- the installed bundle is older than the source checkout; or
- workspace policy blocks the package, Skills, or MCP server.

Actions:

1. Follow the adapter guide for the active harness: Codex, Claude Code, Cline,
   or Pi.
2. Confirm that harness can see the expected GitLab MCP package/configuration
   and canonical Agent Skills.
3. Reinstall or reload the intended verified release artifact, then start a new
   harness session.
4. For a source build, run `npm run build` followed by `npm run smoke` and the
   matching `npm run validate:<harness>` command.
5. Ask a workspace administrator whether plugin, package, Skill, or MCP
   allowlists apply.

For Codex specifically, the established `gitlab` plugin should appear in its
plugin-management surface and continue to use the root Codex compatibility
files. Other harnesses should use their adapter-owned package/configuration
instead of copying those paths.

## Authentication fails with 401

- Confirm `GITLAB_URL` points to the instance root, not `/api/v4`.
- Confirm the token has not expired or been revoked.
- Ensure the environment variable is visible to the process that launches the
  selected local harness distribution, not only to an unrelated terminal.
- Avoid surrounding token values with literal quote characters.
- For HTTP mode, complete OAuth; do not expect a local stdio token to
  authenticate a remote user.

Rotate a token rather than pasting it into diagnostics.

## An insecure GitLab URL is rejected

Plain HTTP is disabled by default because GitLab bearer tokens would otherwise
cross the network without transport encryption. Prefer configuring TLS. For a
development-only instance, `GITLAB_ALLOW_INSECURE_HTTP=true` works only when
`NODE_ENV` is not `production` and `GITLAB_URL` uses a loopback/private-network
IP, a single-label hostname, or `.localhost`, `.local`, `.internal`, or
`.home.arpa`. Public hostnames and wildcard addresses are rejected.

## A tool fails with 403

The token can be valid while the GitLab user lacks the required role, token
scope, licensed feature, or custom permission. Run:

```text
Check GitLab capabilities for group/project with detailed evidence.
```

Use `read_api` for read-only deployments and `api` for API writes. The GitLab
user must still have the project role required by the endpoint.

## A project or object returns 404

GitLab often uses 404 to avoid revealing private resources. Check:

- exact namespace and project spelling;
- whether the project moved;
- URL encoding for subgroup paths;
- the token's membership and project visibility;
- issue/MR IID versus global database ID; and
- tag, branch, file path, and case sensitivity.

Capability discovery reports ambiguous 404s as `unknown`, not unsupported.

## A feature is unavailable or unknown

Project runners, approval rules, protected branches, releases, schedules, and
newer pipeline-input behavior can depend on GitLab version, tier,
configuration, and role. Use `get_gitlab_capabilities` with the project and
`refresh: true` after changing any of those conditions.

## A response is truncated

Logs, artifacts, blobs, raw files, attachments, and errors are deliberately
bounded. Narrow the request to one job or artifact file, use line ranges for
text tools, or retrieve the next result page. Do not disable limits merely to
summarize an entire large artifact.

## A CI/CD variable value is missing

This is expected. Schedule, project, and group variable inspection and mutation
results keep safe metadata but remove the value. Verify secret values through
an authorized GitLab UI workflow when necessary.

## The MCP HTTP endpoint rejects requests

| Symptom                           | Check                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `400` at startup or first request | Validate numeric configuration ranges and `MCP_PUBLIC_URL`.          |
| `401` with `WWW-Authenticate`     | Complete OAuth or provide a valid GitLab bearer token.               |
| `413`                             | Align proxy and `MCP_MAX_REQUEST_BYTES` body limits.                 |
| `429`                             | Reduce concurrency or authentication retries; inspect `Retry-After`. |
| Host validation failure           | Set the exact public host in `MCP_ALLOWED_HOSTS`.                    |
| `/ready` returns `503`            | Confirm the service can reach `GITLAB_URL`.                          |
| `/health` fails                   | Inspect process/container state before GitLab dependencies.          |

Run:

```text
npm run check:gitlab-oauth -- https://gitlab.example.com
npm run check:mcp-deployment -- https://mcp.example.com/mcp
```

## A pipeline is pending

Use `list_project_runners` and inspect:

- at least one runner is online and not paused;
- runner tags match the job;
- protected-branch restrictions permit the runner;
- the runner accepts untagged jobs when jobs have no tags; and
- the runner can pull both `node:22-alpine` and `node:24-alpine` and reach the
  npm registry.

## A development check fails

- `npm test`: fix the reported behavioral or contract failure.
- `npm run test:coverage`: add focused coverage; do not lower thresholds merely
  for a new tool.
- `npm run lint`: fix unused variables/imports and other reported source issues.
- `npm run format:check`: run `npm run format` and review the resulting
  Prettier-only changes rather than bypassing formatting.
- `npm run check:bundle`: inspect the reported harness-specific reference and
  fix the source/build boundary. `npm run build` regenerates the canonical
  bundle at the path configured by `distribution.json`.
- `npm run adapters:check`: run `npm run adapters:generate` for generated
  metadata drift; if the canonical Skills path is reported, fix
  `distribution.json` so it references an existing directory inside the
  repository.
- `npm run check:versions`: align generated distribution/harness release
  metadata with `distribution.json`. `SERVER_VERSION` is independent and should
  be changed only when the harness-neutral MCP core changes.
- `npm run deps:check`: remove a dependency that crosses the documented
  core/shared/adapter boundary rather than weakening the rule.
- `npm run smoke`: confirm the built bundle registers all tools and starts both
  stdio and HTTP modes.
- `npm run validate:harnesses`: fix the specific Codex, Claude Code, Cline, or
  Pi package/handshake failure rather than duplicating core behavior in an
  adapter.
- `npm run release:validate`: confirm all four supported archives are
  deterministic, contain the canonical MCP bundle and Skills, and pass the
  exact cross-harness release-set gate.
- Codex plugin validation: resolve the exact manifest, asset, or Skill error;
  do not remove required metadata to silence validation.

## Collect a safe support report

Include:

- GitLab MCP distribution version and commit SHA;
- active harness (Codex, Claude Code, Cline, Pi, or ChatGPT HTTP);
- Node and GitLab versions;
- stdio or HTTP transport;
- failing command/tool name and sanitized error type;
- request ID when present; and
- minimal reproduction using a non-sensitive project.

Exclude tokens, authorization headers, OAuth codes, private variables,
customer source, full job logs, and confidential issue content. Then follow
[SUPPORT.md](../SUPPORT.md).
