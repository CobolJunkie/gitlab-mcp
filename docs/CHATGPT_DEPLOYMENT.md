# ChatGPT deployment

GitLab MCP can expose the same canonical MCP core used by the local harness
adapters as an internet-facing Streamable HTTP service for ChatGPT. A ChatGPT
connector cannot be activated from source alone; deploy and secure the endpoint
first.

## 1. Deploy the MCP endpoint

Run the generated bundle in HTTP mode behind a TLS-terminating reverse proxy.
`distribution.json` is the source of truth for the bundle path: run
`npm run build`, then launch the file named by its `mcp.bundle` field with Node
and pass `--http`.

Or run the included non-root container:

```text
docker build -t gitlab-mcp .
docker run --rm -p 3000:3000 -e MCP_PUBLIC_URL=https://mcp.example.com/mcp -e MCP_ALLOWED_HOSTS=mcp.example.com -e GITLAB_URL=https://gitlab.example.com gitlab-mcp
```

The example image tag is local deployment identity, not a published harness
artifact. The image deliberately fails before startup in production if either
`MCP_PUBLIC_URL` or the wildcard-listener host allowlist is missing. Keep the
external URL and allowlisted hostname aligned with the TLS reverse proxy's
public host; do not substitute an internal container hostname for either one.
The CI `docker_smoke` job builds this image and, using an isolated mock GitLab
service, checks the preflight failure plus default, explicit-`PORT`, and
`MCP_PORT` fallback listener behavior, Docker health status, liveness,
readiness, protected-resource metadata, and an authenticated MCP request. The
container health probe always connects over loopback and, when an allowed-host
list is configured, presents its first non-empty hostname so the normal host
validation remains enforced.

The server accepts MCP request bodies up to 8 MiB by default so atomic
multi-file commits can include the bundled server. Override this with
`MCP_MAX_REQUEST_BYTES` (65,536 through 26,214,400 bytes), and configure any
ingress or reverse proxy with an equal or larger request-body limit.

Configure:

- `GITLAB_URL`: the GitLab instance, default `https://gitlab.com`;
- `MCP_HOST`: usually the IPv4 wildcard `0.0.0.0` or IPv6 wildcard `::` in a
  container;
- `PORT`: preferred listener port when set;
- `MCP_PORT`: fallback listener port when `PORT` is absent; if neither is
  set, the listener and Docker health check use port `3000`;
- `MCP_PUBLIC_URL`: required in production; canonical HTTPS URL ending in
  `/mcp` without credentials, a query, or a fragment;
- `MCP_ALLOWED_HOSTS`: comma-separated public host allowlist, required for
  either wildcard bind address; and
- `MCP_READ_ONLY`: set to `true` to expose only inspection tools and request
  the GitLab `read_api` OAuth scope instead of full `api`.

For a shared deployment, also size the bounded authentication and concurrency
controls for the expected traffic:

- `MCP_TOKEN_CACHE_MAX_ENTRIES` (default 256);
- `MCP_AUTH_FAILURE_LIMIT` and `MCP_AUTH_FAILURE_WINDOW_MS` (defaults 20
  GitLab `401` invalid-credential rejections per bearer token digest per 60
  seconds; `403` and transient validation failures do not consume this
  per-token bucket);
- `MCP_AUTH_FAILURE_MAX_ENTRIES` (default 1,024) for bounded per-token failure
  state;
- `MCP_AUTH_VALIDATION_LIMIT` and `MCP_AUTH_VALIDATION_WINDOW_MS` (defaults 40
  uncached GitLab token-validation attempts process-wide per 60 seconds; cached
  valid identities bypass this upstream-validation budget);
- `MCP_MAX_CONCURRENT_REQUESTS` (default 32) for global active-request
  admission;
- `MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` (default 4) after successful
  identity validation; and
- `MCP_REQUEST_BODY_READ_TIMEOUT_MS` (default 30 seconds; absolute wall-clock
  deadline for a complete request body, not an idle interval between chunks).

Apply client-IP rate limits at the TLS reverse proxy as well. The application
authentication limiters do not use forwarded client-address headers, so any
client-IP policy should be enforced by the trusted proxy. Set the reverse proxy
body-read timeout longer than the application deadline when clients should
receive the application's sanitized timeout response, leaving enough margin to
avoid a proxy/application timeout race. The application deadline independently
releases request admission when uploads exceed it.

For explicit local HTTP development only, set
`MCP_ALLOW_INSECURE_PUBLIC_URL=true`.

Before registering the connector, validate the GitLab OAuth provider:

```text
npm run check:gitlab-oauth -- https://gitlab.example.com
```

The check fails when OAuth discovery advertises HTTP URLs, lacks dynamic client
registration, omits the required scope, or does not support authorization code,
refresh tokens, and PKCE S256. Refresh-token support is required so the OpenAI
host can renew GitLab's short-lived OAuth access tokens without asking the user
to reconnect. Set `MCP_READ_ONLY=true` when running the check for a read-only
deployment; otherwise it verifies the `api` scope.

When GitLab runs behind a TLS-terminating reverse proxy, its configured external
URL must still be HTTPS. For an Omnibus or Docker Omnibus deployment this
normally means setting:

```ruby
external_url 'https://gitlab.example.com'
nginx['listen_port'] = 80
nginx['listen_https'] = false
```

Keep the internal listener values aligned with the actual proxy topology. Caddy
or another reverse proxy must forward the original host and HTTPS scheme. After
reconfiguration, the OAuth discovery document, authorization endpoint, token
endpoint, registration endpoint, protected-resource metadata, and browser
redirects must all advertise `https://`.

Do not configure `GITLAB_TOKEN` as a shared HTTP credential. Each request should
carry the connected user's GitLab OAuth bearer token. The server validates that
token against `GET /api/v4/user` before dispatch and caches the successful
identity for 60 seconds without retaining the raw token as a cache key.

The deployment exposes:

- `POST /mcp` for stateless Streamable HTTP;
- `GET /.well-known/oauth-protected-resource`;
- `GET /.well-known/oauth-protected-resource/mcp`;
- `GET /health` for process liveness; and
- `GET /ready` for dependency readiness.

The health response intentionally omits the configured GitLab URL. All
responses carry an `X-Request-Id` for privacy-safe correlation. Validate the
deployed endpoint before connector registration:

```text
npm run check:mcp-deployment -- https://mcp.example.com/mcp
```

After every deployment that changes the MCP tool surface, compare the live
`tools/list` response with the canonical tool definitions in the checked-out
source:

```text
MCP_SURFACE_PARITY_TOKEN=<short-lived-bearer-token> \
  npm run check:mcp-surface-parity -- https://mcp.example.com/mcp
```

The bearer token is read only from `MCP_SURFACE_PARITY_TOKEN`; do not place it
on the command line. Run the check with the same `MCP_TOOLSETS` and
`MCP_READ_ONLY` intent as the deployment (or pass `--read-only`) so an
intentional static-toolset filter is not misdiagnosed as drift. The parity
report contains only tool counts, definition
fingerprints, and bounded lists of missing, extra, or stale tool names. It does
not print schemas or credentials. Use `--read-only` when validating a
read-only deployment.

A non-zero result means the deployment must not be treated as synchronized.
Redeploy the exact intended commit, restart the MCP service, rerun the parity
check until it reports `"status": "match"`, then refresh or re-register the
ChatGPT connector and start a new chat so the host rediscovers the current
surface. If the HTTP deployment matches but ChatGPT still exposes stale actions,
the remaining drift is in the connector registration/cache rather than this
server; repeat the connector refresh/re-registration workflow before relying on
new mutation tools.

### Repository-driven production deployment

This repository also provides a protected, manual GitLab `deploy_production`
job for the self-hosted Docker deployment. It is intentionally limited to a
protected default-branch pipeline. Select the protected `main` pipeline for
the exact commit after its required checks pass, then start the manual deploy
job. The manual deployment is optional for pipeline success: repository/main
validation can complete successfully without starting it. When deployment is
required, the `deploy_production` job's own successful completion and runtime
acceptance checks are the authoritative deployment signal. The job connects to
the Docker VM over SSH with strict host-key checking and asks the host to fetch and verify
that exact commit from the configured GitLab repository. It builds with the
repository's Node 22 runtime, sets `MCP_BUILD_ID` to the deployed SHA, stages
and validates a candidate before promotion, and retains the prior container
for rollback. Health, readiness, protected-resource metadata, authenticated
runtime identity/tool count, and authenticated surface parity are blocking
post-deployment checks.

The authenticated runtime identity check derives its expectations from explicit
deployment sources rather than duplicating release metadata:

- the expected distribution version is read from `distribution.json` in the
  exact checked-out release being validated and normalized through the same
  canonical distribution contract used by build/release tooling;
- the expected build ID is the exact requested commit, also exposed to the
  runtime as `MCP_BUILD_ID`;
- the expected tool count comes from the canonical/live surface-parity result
  for that same checkout and deployment intent;
- production deployment mode is required to be `http` with
  `MCP_READ_ONLY=false`; and
- the runtime fingerprint must be a SHA-256 fingerprint, while exact canonical
  surface equality is enforced by the adjacent authenticated
  `check:mcp-surface-parity` validation.

The harness-neutral core `SERVER_VERSION` remains independently versioned and
is not a deployment distribution-version expectation.

Configure these protected GitLab CI/CD variables in the project before using
the job:

- `MCP_DEPLOY_HOST`: Docker VM SSH hostname or address;
- `MCP_DEPLOY_USER`: a dedicated deployment account allowed to run Docker on
  that VM;
- `MCP_DEPLOY_RELEASE_ROOT`: dedicated absolute writable host directory for
  exact-SHA source checkouts. Use only ASCII letters, digits, `_`, `.`, `/`,
  and `-`; traversal segments and the filesystem root itself are rejected
  before any deployment credential is transferred; and
- `MCP_DEPLOY_PUBLIC_URL`: the external HTTPS MCP endpoint with no embedded
  credentials, query, or fragment. Explicit ports and reverse-proxy subpaths are
  accepted when the pathname ends in `/mcp`; a trailing slash after `/mcp`
  is not accepted;
- `MCP_DEPLOY_VALIDATION_TOKEN`: a protected, masked, hidden,
  `production`-environment-scoped GitLab bearer token used only by
  authenticated deployment/runtime parity checks. Provision it as a dedicated
  project access token with Guest access and the `read_api` scope only, give it
  a finite expiration, and rotate it before expiry without broadening either
  access level or scope. It is not a runtime service credential and is never
  copied into the production container environment;
- `MCP_DEPLOY_SSH_PRIVATE_KEY_B64`: a protected, masked, hidden variable
  containing the base64-encoded dedicated SSH key for that account; and
- `MCP_DEPLOY_KNOWN_HOSTS`: a **file** variable containing the verified
  `known_hosts` entry for the Docker VM.

Use a deploy-only key, restrict it to this VM, and verify the VM host key
fingerprint out-of-band before putting its public key in the known-hosts file.
The job decodes the key into a temporary mode-600 file and removes it on exit.
The validated public URL is transported to the remote deployer as URL-safe
base64 and decoded before the same validator is applied there, so reverse-proxy
paths are never interpolated as shell syntax. Do not use
`StrictHostKeyChecking=no`, a shared administrator key, or a committed private
key. The deployment account needs Docker access because the
production service is managed as a Docker container; Docker-daemon access is
effectively host-level authority, so the SSH key and GitLab variables must be
protected and narrowly scoped. The CI job transfers the dedicated validation
credential over SSH standard input into a randomized mode-600 temporary file
under the validated release root. The remote deployer rejects symlinks,
consumes and removes that file before Docker mutation, then exposes the
credential only through temporary
mode-600 env files for authenticated validation containers. Cleanup also removes
the transfer file if the streamed deployer fails before consuming it. The
credential is never placed on a command line, emitted to job logs, or copied
into the production service environment. Replacement public HTTP containers
explicitly omit both `GITLAB_TOKEN` and `GITLAB_PRIVATE_TOKEN`, so per-request
OAuth remains the normal runtime authentication boundary.

The deployment account must have read, write, and execute access to the
configured release root. The current Docker VM grants this through the Docker
group with setgid inheritance. The deployer checks write access to an existing
SHA checkout before reusing it. If a root-owned checkout is not writable, it
leaves that checkout untouched and creates or reuses a separate
`<sha>-deploy` checkout. Git's `safe.directory` setting only addresses Git's
ownership guard; it does not grant filesystem write access. Every checkout
used for a deployment is reset to and verified against the requested origin
SHA before building.

Deployment-owned host state is reconciled toward a bounded steady state. Before
a new build begins, the deployer removes stale candidate/failed containers,
keeps only the newest existing `gitlab-mcp-rollback-*` container, and prunes old
exact-SHA release checkouts and `gitlab-mcp:sha-*` image tags while preserving
the running production build and that retained rollback build. After a
successful promotion, the same reconciliation keeps only the new production
build and its immediate prior
rollback container/build; the stopped candidate and superseded rollback state
are removed. Image removal is non-forcing, so an image unexpectedly referenced
by another container is left in place with a warning rather than deleting
unrelated runtime state. If the retained rollback build cannot be identified by
an exact SHA, older rollback containers are also preserved rather than risking
the last provable recovery point. If either the running production build or a
retained rollback build cannot be identified by an exact SHA, the deployer
skips image/check-out pruning rather than guessing. A legacy release checkout
that the deployment account cannot remove is likewise retained with a warning
instead of turning cleanup into a deployment failure; reconcile its ownership
manually so later deployments can remove it.

Source checkouts remain under `<MCP_DEPLOY_RELEASE_ROOT>/<sha>` (or
`<sha>-deploy` when the original path is not writable). In the normal verified
state, one retained rollback container remains named
`gitlab-mcp-rollback-*`; degraded identity state can temporarily preserve
additional rollback containers as described above. A failed post-promotion
check automatically restores the prior container. Cleanup runs before the build
specifically so accumulated deployment-owned state can be reclaimed before
package installation or image creation needs additional disk space. To
intentionally roll back to an older repository version, start
`deploy_production` from that version's successful protected `main` pipeline;
the job fetches/rebuilds and validates that exact SHA through the same path.

#### Manual recovery if automatic rollback fails

If the deployer reports that automatic rollback failed, stop further deployment
mutations and preserve the production, rollback, failed, candidate, SHA-image,
and release-checkout state until the intended recovery container is identified.
List the deployment containers without inspecting their environment (which can
contain credentials):

```text
docker ps -a --filter "name=gitlab-mcp" --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
docker inspect --format '{{.Name}} {{.Config.Image}} {{.State.Status}}' gitlab-mcp
docker inspect --format '{{.Name}} {{.Config.Image}} {{.State.Status}}' <rollback-container>
```

Compare the reported image identity with the known-good prior deployment before
renaming anything. Automatic recovery can fail after the rollback has already
been renamed back to `gitlab-mcp` but before it starts. If `gitlab-mcp`
already identifies the known-good prior image, leave its name unchanged, start
it if necessary, and proceed directly to validation.

Otherwise, normally choose the newest
`gitlab-mcp-rollback-<timestamp>` whose image identity matches the known-good
prior deployment. If the replacement `gitlab-mcp` container still exists,
stop it and preserve it under a failed-state name before restoring the selected
rollback. If the replacement is already absent, skip those first two commands:

```text
docker stop --time 2 gitlab-mcp
docker rename gitlab-mcp "gitlab-mcp-failed-$(date +%s%3N)"
docker rename <rollback-container> gitlab-mcp
docker start gitlab-mcp
```

If neither the current production name nor a retained rollback can be matched
to the known-good prior deployment, do not guess and do not delete any
deployment state; reconcile the exact build identity before attempting further
mutation. Re-run the normal health/readiness, authenticated runtime identity,
and surface parity checks before removing any preserved failed/candidate state.
Do not use a global Docker prune as part of recovery. After service is verified,
a later protected deployment can reconcile deployment-owned retention state
through the normal bounded cleanup path.

## 2. Test OAuth and tools

In ChatGPT developer mode, create a connector pointing at the public `/mcp`
URL. Complete GitLab OAuth, then test representative read and write operations
against a non-production project.

GitLab's authorization server and dynamic client registration support vary by
GitLab version and instance policy. For self-managed installations, confirm
that the instance's OAuth configuration meets ChatGPT's current MCP
authentication requirements. If it does not, place a standards-compliant OAuth
broker in front of this server; the MCP server only requires a valid GitLab
bearer token on the incoming request.

GitLab.com currently publishes OAuth discovery, DCR, PKCE, and the `api` scope.
GitLab access tokens are opaque to this service, so the server can validate
them against GitLab but cannot independently verify a custom `aud` claim. Test
the complete flow in ChatGPT developer mode before publication; a public
security review may require an OAuth broker or identity provider that issues
resource-audience-bound tokens.

## 3. Link the registered app to the Codex compatibility distribution

ChatGPT registration returns a technical app ID. The established Codex
compatibility distribution owns `.app.json`; add the real ID only after
registration succeeds:

```json
{
  "apps": {
    "gitlab": {
      "id": "<technical-app-id>",
      "required": true
    }
  }
}
```

Do not commit a guessed ID. Validate the Codex distribution again after adding
the file. Other harness adapters do not depend on `.app.json`.

## 4. Publication

Private use can stop after developer-mode testing. A public listing additionally
requires final branding, developer-controlled privacy and terms URLs, security
review, and the applicable publication process.

The canonical release process and four-harness artifact requirements are in
[RELEASING.md](RELEASING.md) and
[PUBLICATION_CHECKLIST.md](PUBLICATION_CHECKLIST.md).

Current references:

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/build/auth>
- <https://developers.openai.com/plugins/deploy/connect-chatgpt>
- <https://docs.gitlab.com/user/model_context_protocol/mcp_server/>
