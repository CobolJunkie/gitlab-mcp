# GitLab MCP
> **Public mirror:** This repository is a curated snapshot of the [canonical GitLab project](https://gitlab.villainmindset.org/CobolJunkie/gitlab-codex-plugin). GitLab is the source of truth for development, CI, and releases. This snapshot follows v0.2.0 (October 2, 2026); GitHub history is intentionally kept as a clean public release record.


GitLab MCP is a harness-neutral Model Context Protocol server plus shared Agent
Skills for GitLab repository work. Codex, Claude Code, Cline, and Pi are
supported distributions of the same canonical MCP core rather than separate
GitLab implementations. ChatGPT can use the same core through the remote
Streamable HTTP deployment.

The project provides:

- a self-contained GitLab MCP server with typed tools;
- a general `$gitlab` skill;
- `$gl-address-comments` for unresolved merge-request discussions;
- `$gl-fix-ci` for pipeline and job diagnosis;
- `$gl-publish` for branch, commit, push, and draft-MR delivery;
- GitLab-native runner, CI lint, governance, tag, release, and pipeline
  schedule workflows, plus secret-safe project and group CI/CD variable
  management;
- thin Codex, Claude Code, Cline, and Pi distributions that reuse the same
  canonical core and Agent Skills; and
- stateless Streamable HTTP transport and OAuth protected-resource metadata
  for ChatGPT deployment.

## Start here

| Audience          | Documentation                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitLab MCP users  | [User guide](docs/USER_GUIDE.md)                                                                                                                       |
| Codex users       | [Codex adapter](adapters/codex/README.md)                                                                                                              |
| Claude Code users | [Claude Code adapter](adapters/claude/README.md)                                                                                                       |
| Cline users       | [Cline adapter](adapters/cline/README.md)                                                                                                              |
| Pi users          | [Pi adapter](adapters/pi/README.md)                                                                                                                    |
| Operators         | [Configuration reference](docs/CONFIGURATION.md) and [troubleshooting](docs/TROUBLESHOOTING.md)                                                        |
| Architects        | [Architecture overview](docs/ARCHITECTURE.md) and [ADR-001](docs/ADR-001-harness-neutral-core.md)                                                      |
| Contributors      | [Developer guide](docs/DEVELOPER_GUIDE.md) and [contributing guide](CONTRIBUTING.md)                                                                   |
| Deployers         | [ChatGPT deployment](docs/CHATGPT_DEPLOYMENT.md)                                                                                                       |
| Maintainers       | [Release process](docs/RELEASING.md), [publication checklist](docs/PUBLICATION_CHECKLIST.md), and [generalisation audit](docs/GENERALISATION_AUDIT.md) |

The [documentation index](docs/README.md) links the complete user, operator,
developer, security, compatibility, and release documentation set.

## Quick Start

For a local source installation, use Node.js 22 or newer, then build and verify
the canonical MCP core:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
```

Choose the adapter that matches the harness. All four supported adapters consume
the same built MCP bundle and canonical Agent Skills.

For Codex, add this repository to a trusted local marketplace, install the
`gitlab` plugin, and restart or refresh Codex. The established root Codex
manifest, `.mcp.json`, preload, and artifact name remain supported compatibility
surfaces. Configure the GitLab instance and token in the environment that
launches Codex:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_TOKEN = "<token>"
```

Start a new conversation and ask Codex to confirm the connection, for example:

```text
Use GitLab to tell me which account and instance are connected.
```

Claude Code users can load the materialized native plugin distribution, which
bundles the same MCP server and canonical Agent Skills. See the
[Claude Code adapter guide](adapters/claude/README.md) for package validation,
`--plugin-dir` loading, and marketplace-compatible layout.

Cline users can use the same canonical MCP bundle over stdio and install the
canonical Agent Skills without a separate GitLab implementation. See the
[Cline adapter guide](adapters/cline/README.md) for IDE and CLI setup.

Pi users can install the dedicated Pi package, which registers the canonical MCP
tool inventory through a thin stdio bridge and exposes the same Agent Skills.
See the [Pi adapter guide](adapters/pi/README.md) for package installation,
runtime dependency handling, and bridge limitations.

See the [user guide](docs/USER_GUIDE.md) for least-privilege token guidance,
common GitLab workflows, and ChatGPT HTTP deployment.

## Requirements

- Node.js 22 or newer
- a GitLab.com, GitLab Dedicated, or self-managed GitLab instance
- for local stdio use, a GitLab token with the minimum scopes required by the
  operations you intend to perform

## Build and verify

```powershell
npm.cmd install
npm.cmd test
npm.cmd run adapters:check
npm.cmd run check:bundle
npm.cmd run build
npm.cmd run validate:codex
npm.cmd run validate:claude
npm.cmd run validate:cline
npm.cmd run validate:pi
npm.cmd run check:versions
npm.cmd run check:gitlab-oauth -- https://gitlab.example.com
```

The canonical MCP bundle path is defined by `distribution.json`; the current
configuration builds `server/dist/gitlab-mcp.cjs`. The MCP bundle itself is
generated and ignored in source control, then included in release artifacts.
Harness packages may still declare a harness-side runtime dependency; the Pi
package, for example, uses the MCP SDK to bridge Pi to that bundled server.

`distribution.json` is the authoritative source for shared distribution
metadata, including the neutral `gitlab` distribution identifier, base
version, description, license, canonical MCP bundle, and Skills path. After
changing it, run `npm run adapters:generate` and review the generated
Codex/Claude Code/Cline/Pi metadata. `npm run adapters:check` rejects metadata
drift and a missing, non-directory, or repository-escaping canonical Skills
path.

`npm run check:bundle` performs an in-memory clean build and fails if the
canonical bundle contains harness-specific implementation references.
`npm run check:versions` verifies generated package and Codex release metadata
remain aligned with `distribution.json`. The Codex plugin manifest may append
Codex build metadata after `+` without changing that base distribution version.
`SERVER_VERSION` is owned independently by the harness-neutral MCP core and is
bumped only when the core runtime itself changes.

The harness-neutral core and adapter boundary are documented in
[ADR-001](docs/ADR-001-harness-neutral-core.md). The GEN-08 focused audit and
identity decisions are recorded in
[docs/GENERALISATION_AUDIT.md](docs/GENERALISATION_AUDIT.md).

## Continuous integration

GitLab merge-request, default-branch, and tag pipelines run syntax checks,
tests, coverage, dependency-cruiser, formatting/linting, a production dependency
audit, a clean bundle build, and bundled stdio/HTTP smoke tests. GitLab SAST and
secret-detection templates are also enabled. Codex, Claude Code, Cline, and Pi
each have focused adapter validation after the canonical build; those jobs
validate harness packaging and MCP startup without repeating the core
Node/security matrix. The Node 22/24 test matrix publishes the same single-pass
test execution as JUnit reports, so GitLab's Tests view exposes suite/case
results without rerunning the suite for presentation.

Tag pipelines additionally publish the deterministic Codex archive with its
CycloneDX SBOM and `SHA256SUMS`, plus reproducible Claude Code, Cline, and Pi
MCP + Skills archives with matching `.sha256` sidecars, as GitLab job artifacts.
The final release-set gate requires exactly the four supported harnesses and
compares their canonical MCP bundle and Skills digests. Releases are not
considered complete until the artifacts are verified according to
[docs/PUBLICATION_CHECKLIST.md](docs/PUBLICATION_CHECKLIST.md).

The committed `docs/gitlab-tool-contracts.json` inventory invokes every
registered tool with boundary-valid inputs and locks its safety classification,
HTTP method, encoded route, query/body mapping, and bounded response mode.
Coverage covers every production source module and fails below 90% lines, 80%
functions, or 75% branches; adding a tool without an inventory entry fails the
test.

The syntax and test jobs run on both `node:22-alpine` and `node:24-alpine`;
the threshold-enforced coverage job runs on Node 22. The core jobs require an
untagged Linux runner that can run these images and reach the npm registry. The
security templates pull their analyzer images from the GitLab registry.
Privileged mode is not required for the core Node.js jobs. Configure at least
one project, group, or instance runner that accepts untagged jobs and permits
jobs to run for at least 10 minutes before requiring successful pipelines for
merge.

## Local Codex authentication

Set the instance URL and token in the environment that launches Codex:

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"
$env:GITLAB_TOKEN = "<token>"
```

`GITLAB_URL` must use HTTPS by default and rejects embedded credentials,
queries, and fragments. For an explicitly local/private development GitLab
instance that cannot use TLS, set `GITLAB_ALLOW_INSECURE_HTTP=true`. The
override is rejected in production and for public hostnames; it accepts
loopback, private-network IPs, single-label hosts, and the private-development
suffixes `.localhost`, `.local`, `.internal`, and `.home.arpa`.

`GITLAB_URL` defaults to `https://gitlab.com`. The Codex `.mcp.json` starts the
bundled server over stdio and loads the thin Codex distribution adapter before
the harness-neutral core. Tokens are read at runtime and are never stored in a
distribution.

Use the narrowest token scopes that cover the task. Read-only work can use a
read-oriented token; repository, issue, merge-request, or CI mutations require
the corresponding GitLab API permissions.

## Capability discovery

Call `get_gitlab_capabilities` before diagnosing whether a GitLab operation is
unsupported, unlicensed, disabled, or merely inaccessible to the current
credential. It uses only read-only requests to `/user`, `/version`, `/metadata`,
`/personal_access_tokens/self`, and (when the credential is not a personal
access token) `/oauth/token/info`. OAuth diagnostics report scopes and remaining
lifetime but never expose the token or OAuth application identifier. GitLab may
hide or omit these endpoints, especially on older self-managed versions or for
non-administrators, so ambiguous results are reported as `unknown` rather than
guessed.

Each capability is one of `available`, `unavailable`,
`permission_required`, `license_required`, `not_configured`, or `unknown`,
with a concise reason and supporting evidence where useful. Pass
`detailed: true` for normalized per-probe outcomes, or `refresh: true` to
bypass the cache.

Results are cached for 60 seconds per normalized instance URL and authenticated
credential identity. The cache key contains a one-way SHA-256 digest, never the
raw bearer token. Entries expire after 60 seconds, are bypassed by `refresh`,
and naturally separate instances or changed credentials. Expired entries are
opportunistically removed, and a 256-entry LRU limit provides a hard memory
bound. The cache is in-memory only and is cleared when the MCP server process
restarts.

## HTTP server

For local development:

```powershell
$env:MCP_PUBLIC_URL = "https://mcp.example.com/mcp"
$env:GITLAB_URL = "https://gitlab.example.com"
npm.cmd run start:http
```

HTTP mode requires a bearer token on every `/mcp` request. A server-side token
is disabled by default. `ALLOW_SERVER_TOKEN_HTTP=true` exists only for
controlled private testing and should not be used for a shared deployment.

Set `MCP_READ_ONLY=true` for an inspection-only deployment. In that mode the
server registers only tools annotated as read-only and advertises GitLab's
`read_api` OAuth scope. The default write-enabled mode exposes the complete
tool set and requires `api`. The server validates every tool annotation during
registration so an unclassified or mutating tool cannot silently enter the
read-only surface.

When binding to the IPv4 wildcard `0.0.0.0` or IPv6 wildcard `::`, set
`MCP_ALLOWED_HOSTS` to a comma-separated allowlist of public host names. Put
the service behind HTTPS and set `MCP_PUBLIC_URL` to its canonical public
`/mcp` URL. Production mode requires `MCP_PUBLIC_URL`, rejects embedded
credentials, queries, fragments (including empty `?`/`#` delimiters), and
non-`/mcp` paths, and requires HTTPS.
`MCP_ALLOW_INSECURE_PUBLIC_URL=true` is available only for explicit local
development on a loopback listener and is rejected in production or on a
public host. `ALLOW_SERVER_TOKEN_HTTP=true` is likewise limited to loopback
private testing and must not be used for a shared deployment.

Use the read-only `get_runtime_info` tool after installation or deployment to
confirm the core/distribution versions, deployment mode, read-only filtering,
and the deterministic SHA-256 fingerprint of the registered tool inventory.

HTTP MCP request bodies are limited to 8 MiB by default. This accommodates
bounded multi-file commits and other legitimate large tool payloads while
preventing unbounded request buffering. Set `MCP_MAX_REQUEST_BYTES` to an
integer from 65,536 through 26,214,400 bytes to use a different deployment
limit. Any reverse proxy in front of the server must allow at least the same
request size.

Long-running HTTP deployments also bound authentication and request state:

- `MCP_TOKEN_CACHE_MAX_ENTRIES` limits validated bearer identities, default
  256, with a 60-second TTL and LRU eviction;
- `MCP_AUTH_FAILURE_LIMIT` limits repeated GitLab `401` invalid-credential
  rejections for one bearer token digest within `MCP_AUTH_FAILURE_WINDOW_MS`,
  default 20 failures per 60 seconds; GitLab `403` authorization failures and
  transient validation failures do not consume this per-token bucket;
- `MCP_AUTH_FAILURE_MAX_ENTRIES` bounds per-token failure-tracking state,
  default 1,024;
- `MCP_AUTH_VALIDATION_LIMIT` caps uncached GitLab token-validation attempts
  across the process within `MCP_AUTH_VALIDATION_WINDOW_MS`, default 40 per 60
  seconds; cached valid identities bypass this upstream-validation budget;
- `MCP_MAX_CONCURRENT_REQUESTS` caps active MCP requests, default 32;
- `MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` caps requests for one validated
  GitLab user, default 4; and
- `MCP_REQUEST_BODY_READ_TIMEOUT_MS` bounds each complete request-body read by
  an absolute wall-clock deadline, default 30 seconds.

Configure complementary client-IP rate, request, and connection limits at the
TLS reverse proxy. The application limiter buckets do not use forwarded
client-address headers, so proxy-level client-IP controls should be enforced by
the trusted proxy before traffic reaches this service.

The unauthenticated `/health` endpoint is a topology-free process liveness
check. `/ready` is a separate readiness check and returns `503` when its
dependency probe is unavailable. Every response includes a generated
`X-Request-Id`; internal MCP failures log only that identifier and the error
type. Embedders can provide a request-completion observer for metrics without
receiving bearer tokens or request payloads.

After deploying, verify the public resource metadata and both health semantics:

```powershell
npm.cmd run check:mcp-deployment -- https://mcp.example.com/mcp
```

## Safety model

- Tools advertise read-only, write, and destructive annotations.
- `create_commit` supports only non-destructive file actions; deletion and
  forced commit updates require the separately annotated
  `create_destructive_commit` tool. Non-force destructive update/move actions
  require reviewed per-file concurrency guards in addition to the reviewed
  branch head; force mode explicitly replaces history from that reviewed head.
- GitLab response bodies, including job logs, artifacts, and API errors, are
  streamed under strict byte limits and remain covered by request timeouts;
- API errors are normalized without echoing credentials;
- capability discovery redacts error evidence and never reads private CI
  variables or mutation endpoints;
- HTTP bearer tokens are validated against the configured GitLab instance and
  cached by a one-way token hash in a bounded TTL/LRU cache;
- rejected credentials and concurrent requests are bounded without logging
  tokens or private identity details;
- HTTP mode challenges unauthenticated requests with protected-resource
  metadata;
- HTTP tools advertise per-tool OAuth or private server-token security schemes
  plus model-visible reauthorization challenges; and
- Skills require explicit intent for merge, approval, deletion, discussion
  resolution, and CI state changes.

## License

MIT
