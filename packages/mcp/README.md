# @workflowy/mcp

MCP server for a Workflowy outline. One set of tool definitions (`registerWorkflowyTools` in `src/register.ts`, exported as `@workflowy/mcp/tools`) runs on two hosts:

- **stdio**, over the local `workflowy.sqlite` cache (`src/index.ts`).
- **Streamable HTTP**, at `/mcp` on the Cloudflare Worker, over the signed-in user's Durable Object (`packages/cloudflare/src/mcp.ts`). This is the outline the deployed web app shows.

Both hosts send every tool through the web app's ops, so MCP, the web UI and the CLI share one write path.

## Tools

- Read: `workflowy_node_get`, `workflowy_node_list`, `workflowy_node_changes`, `workflowy_search`, `workflowy_calendar_day`, `workflowy_cache_status`.
- Write: `workflowy_node_create`, `workflowy_node_update`, `workflowy_node_delete`, `workflowy_node_complete`, `workflowy_node_uncomplete`, `workflowy_node_move`, `workflowy_node_mirror`.

Node tools accept a full or short id, or a comma path. Read results use the same JSON shape as the CLI (`workflowy node schema`).

## Connect to the deployed Worker

`/mcp` takes OAuth bearer tokens only. The Worker is its own authorization server (`@cloudflare/workers-oauth-provider`). Login goes through the existing Cloudflare Access app: the `/authorize` consent page sits behind Access, and it grants the token to the Access email that signed in. Service-token headers do not work on `/mcp`.

The consent page offers two levels:

- **Read only** (`mcp:read`): the client sees only the read tools. `workflowy_calendar_day` with `ensure` is refused.
- **Read and write** (`mcp:read mcp:write`): all tools.

To change the level, remove the connection and connect again. The email is checked against `ALLOWED_EMAILS` on every request, so removing it from the allowlist cuts off live tokens immediately.

### claude.ai (web, Desktop, mobile)

- Settings → Connectors → Add custom connector.
- URL: `https://<host>/mcp`. Leave the OAuth client id and secret empty. Claude registers itself (CIMD, or DCR as a fallback).
- Connect, sign in to Access in the popup, choose the access level and click Allow.

### Claude Code

```sh
claude mcp add --transport http workflowy https://<host>/mcp
```

Then run `/mcp` in Claude Code, pick `workflowy` and authenticate. The browser opens the same Access login and consent page. Claude Code identifies itself with its own client metadata document and receives the token on a loopback redirect.

### Other MCP clients

Any client that supports Streamable HTTP and MCP OAuth (PKCE S256, with CIMD or dynamic client registration at `/oauth/register`) can connect. An unauthenticated request to `/mcp` returns `401` with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource/mcp`. `/mcp` is stateless JSON: `POST` only, and `GET` and `DELETE` return `405`.

## Run locally over stdio

Build it, then point the client at `bin/mcp.js`. It reads `WORKFLOWY_DB_PATH` (default: `workflowy.sqlite` in the working directory) and needs `WORKFLOWY_API_KEY` for writes.

```sh
just build
claude mcp add workflowy-local \
  -e WORKFLOWY_DB_PATH=/abs/path/workflowy.sqlite \
  -e WORKFLOWY_API_KEY=... \
  -- node /abs/path/packages/mcp/bin/mcp.js
```

The stdio host has no scopes: every tool is registered.
