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
service, checks the preflight failure, liveness, readiness, protected-resource
metadata, and an authenticated MCP request.

The server accepts MCP request bodies up to 8 MiB by default so atomic
multi-file commits can include the bundled server. Override this with
`MCP_MAX_REQUEST_BYTES` (65,536 through 26,214,400 bytes), and configure any
ingress or reverse proxy with an equal or larger request-body limit.

Configure:

- `GITLAB_URL`: the GitLab instance, default `https://gitlab.com`;
- `MCP_HOST`: usually the IPv4 wildcard `0.0.0.0` or IPv6 wildcard `::` in a
  container;
- `PORT` or `MCP_PORT`: listener port;
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
  failures per directly connected address per 60 seconds);
- `MCP_AUTH_FAILURE_MAX_ENTRIES` (default 1,024);
- `MCP_MAX_CONCURRENT_REQUESTS` (default 32); and
- `MCP_MAX_CONCURRENT_REQUESTS_PER_IDENTITY` (default 4).

Apply client-IP rate limits at the TLS reverse proxy as well. The application
does not trust forwarded client-address headers by default.

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
