import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {StoreClient} from "@outlinedb/web/server-app";
import {jsonResult, opError} from "./results.js";

export function registerCacheTools(server: McpServer, store: StoreClient): void
{
	server.registerTool(
		"outlinedb_cache_status",
		{
			description: "Get cache database status and statistics",
			inputSchema: {},
		},
		async () =>
		{
			const status = await store.call("cache.status", {});
			return status.ok ? jsonResult(status.value) : opError(status);
		},
	);
}
