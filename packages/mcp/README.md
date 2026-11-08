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

`/mcp` takes OAuth bearer tokens only. The Worker is its own authorization server (`@cloudflare/workers-oauth-provider`). Login is your OutlineDB account: the `/authorize` consent page needs a signed-in session, and without one it sends the browser to `/login` and back. The token acts as that OutlineDB user and reads and writes that user's outline. A Cloudflare Access identity also works when its email has a verified OutlineDB account. Service-token headers do not work on `/mcp`.

The consent page offers two levels:

- **Read only** (`mcp:read`): the client sees only the read tools. `workflowy_calendar_day` with `ensure` is refused.
- **Read and write** (`mcp:read mcp:write`): all tools.

To change the level, remove the connection and connect again. The user is checked on every request, so deleting the account or un-verifying its email cuts off live tokens immediately.

### claude.ai (web, Desktop, mobile)

- Settings → Connectors → Add custom connector.
- URL: `https://<host>/mcp`. Leave the OAuth client id and secret empty. Claude registers itself (CIMD, or DCR as a fallback).
- Connect, log in to OutlineDB in the popup if asked, choose the access level and click Allow.

### Claude Code

```sh
claude mcp add --transport http workflowy https://<host>/mcp
```

Then run `/mcp` in Claude Code, pick `workflowy` and authenticate. The browser opens the same OutlineDB login and consent page. Claude Code identifies itself with its own client metadata document and receives the token on a loopback redirect.

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
