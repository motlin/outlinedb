# @outlinedb/mcp

MCP server for an OutlineDB outline. One set of tool definitions (`registerOutlineTools` in `src/register.ts`, exported as `@outlinedb/mcp/tools`) runs on two hosts:

- **stdio**, over the local `workflowy.sqlite` cache (`src/index.ts`).
- **Streamable HTTP**, at `/mcp` on the Cloudflare Worker, over the signed-in user's Durable Object (`packages/cloudflare/src/mcp.ts`). This is the outline the deployed web app shows.

Both hosts send every tool through the web app's ops, so MCP, the web UI and the CLI share one write path.

## Tools

- Read: `outlinedb_node_get`, `outlinedb_node_list`, `outlinedb_node_changes`, `outlinedb_search`, `outlinedb_calendar_day`, `outlinedb_cache_status`.
- Write: `outlinedb_node_create`, `outlinedb_node_update`, `outlinedb_node_delete`, `outlinedb_node_complete`, `outlinedb_node_uncomplete`, `outlinedb_node_move`, `outlinedb_node_mirror`.

Node tools accept a full or short id, or a comma path. Read results use the same JSON shape as the CLI (`workflowy node schema`).

## Connect to the deployed Worker

`/mcp` takes OAuth bearer tokens only. The Worker is its own authorization server (`@cloudflare/workers-oauth-provider`). Login is your OutlineDB account: the `/authorize` consent page needs a signed-in session, and without one it sends the browser to `/login` and back. The token acts as that OutlineDB user and reads and writes that user's outline. A Cloudflare Access identity also works when its email has a verified OutlineDB account. Service-token headers do not work on `/mcp`.

The consent page offers two levels:

- **Read only** (`mcp:read`): the client sees only the read tools. `outlinedb_calendar_day` with `ensure` is refused.
- **Read and write** (`mcp:read mcp:write`): all tools.

To change the level, remove the connection and connect again. The user is checked on every request, so deleting the account or un-verifying its email cuts off live tokens immediately.

### claude.ai (web, Desktop, mobile)

- Settings → Connectors → Add custom connector.
- URL: `https://<host>/mcp`. Leave the OAuth client id and secret empty. Claude registers itself (CIMD, or DCR as a fallback).
- Connect, log in to OutlineDB in the popup if asked, choose the access level and click Allow.

### Claude Code

```sh
claude mcp add --transport http outlinedb https://<host>/mcp
```

Then run `/mcp` in Claude Code, pick `outlinedb` and authenticate. The browser opens the same OutlineDB login and consent page. Claude Code identifies itself with its own client metadata document and receives the token on a loopback redirect.

### Other MCP clients

Any client that supports Streamable HTTP and MCP OAuth (PKCE S256, with CIMD or dynamic client registration at `/oauth/register`) can connect. An unauthenticated request to `/mcp` returns `401` with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource/mcp`. `/mcp` is stateless JSON: `POST` only, and `GET` and `DELETE` return `405`.

## Run locally over stdio

Build it, then point the client at `bin/mcp.js`. It reads `WORKFLOWY_DB_PATH` (default: `workflowy.sqlite` in the working directory) and needs `WORKFLOWY_API_KEY` for writes.

```sh
just build
claude mcp add outlinedb-local \
  -e WORKFLOWY_DB_PATH=/abs/path/workflowy.sqlite \
  -e WORKFLOWY_API_KEY=... \
  -- node /abs/path/packages/mcp/bin/mcp.js
```

The stdio host has no scopes: every tool is registered.
