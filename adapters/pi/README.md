# GitLab MCP for Pi

This distribution packages the canonical GitLab MCP server and shared Agent Skills for Pi. The Pi-specific code is a thin MCP client bridge: it starts the packaged stdio server, discovers its tools, registers them with Pi, forwards tool calls unchanged, and closes the MCP client during Pi session shutdown.

## Install

Pi can install packages from npm, Git, URLs, or local paths. For a published package, use the normal Pi package command. For a materialized release directory, install its runtime dependency first and then point Pi at that directory:

```sh
cd /absolute/path/to/gitlab-pi-mcp
npm install --omit=dev
pi install /absolute/path/to/gitlab-pi-mcp
```

The package exposes `extensions/gitlab-mcp.mjs` and the canonical `skills/` directory through its `pi` manifest. npm and Git package installations use the runtime dependency declared by the packaged `package.json`.

## Configuration

Set the same GitLab environment variables used by the canonical MCP server before starting Pi. At minimum, configure the GitLab URL and an appropriately scoped token for the operations you intend to perform. Credentials are inherited by the child MCP process at runtime; they are not generated into package metadata.

## Bridge behavior

- MCP tool names, descriptions, and JSON input schemas are registered without GitLab-specific rewriting.
- Tools explicitly annotated by MCP as read-only may run in Pi's parallel execution mode. Every other tool is registered sequentially, so missing or ambiguous annotations never make a potential mutation more concurrent.
- MCP text and image result blocks are preserved directly. Content types Pi cannot represent natively are serialized into tool-result text rather than silently discarded.
- MCP `structuredContent`, tool annotations, and result metadata are retained under Pi tool-result `details.mcp`.
- MCP error results become thrown Pi tool execution errors, matching Pi's extension error contract.
- Tool discovery follows MCP pagination and rejects duplicate tool names or unbounded pagination.
- Pi cancellation is honored before dispatch and forwarded to the MCP SDK for in-flight stdio requests.
- When Pi runs as its official Bun-compiled standalone executable, the bridge reuses that executable in Bun CLI mode (`BUN_BE_BUN=1`) so the child process executes the packaged MCP bundle rather than recursively starting Pi. The launch-mode override is set internally and is not inherited from user configuration.

## Fidelity limits

Pi's tool-registration contract exposes the input parameter schema but does not provide a separate MCP `outputSchema` or generic annotation field. The bridge therefore preserves the MCP input schema directly, maps only an explicit `readOnlyHint` into Pi's execution mode, and retains structured MCP results plus annotations in `details.mcp`. It does not invent Pi-side validation or safety semantics for MCP metadata that Pi cannot represent natively.

MCP result content types that Pi cannot represent directly are serialized into text instead of being discarded. This keeps the information visible while avoiding harness-specific GitLab behavior.

Pi currently has an upstream provider-layer compatibility issue for some OpenAI-compatible completions endpoints: valid object tool schemas that omit a `required` array may be rejected before generation begins. See [earendil-works/pi#7010](https://github.com/earendil-works/pi/issues/7010). The bridge deliberately preserves valid MCP schemas instead of adding provider-specific fields. Use a Pi/provider combination that accepts the schema or a Pi release containing the upstream normalization fix if you encounter this error. The adapter's runtime smoke tests do not make an LLM API call and therefore do not claim provider-side schema compatibility.

## Architecture

The Pi extension contains no GitLab API implementation, response sanitizer, mutation policy, or tool-specific business logic. Those remain in the canonical MCP core. The adapter depends on the MCP SDK only to bridge Pi's extension API to the packaged stdio server.

The package reuses the canonical `distribution.json`, generated MCP bundle, and shared Skills. Changes to GitLab behavior therefore benefit Pi automatically without a Pi-specific implementation fork.
