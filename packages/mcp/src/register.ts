import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {StoreClient} from "@workflowy/web/node-host";
import {registerCacheTools} from "./tools/cache-tools.js";
import {registerCalendarTools} from "./tools/calendar-tools.js";
import {registerNodeTools} from "./tools/node-tools.js";
import {registerSearchTools} from "./tools/search-tools.js";

/**
 * Every Workflowy tool, each a thin adapter over the store's ops. The stdio host passes an in-process store over the
 * local cache; a Worker can pass a Durable Object's store client.
 */
export function registerWorkflowyTools(server: McpServer, store: StoreClient): void {
	registerNodeTools(server, store);
	registerCalendarTools(server, store);
	registerCacheTools(server, store);
	registerSearchTools(server, store);
}
