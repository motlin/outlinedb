import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {OpInput, OpName, OpOutput, OpResult, StoreClient} from "@outlinedb/web/server-app";
import {registerCacheTools} from "./tools/cache-tools.js";
import {registerCalendarTools} from "./tools/calendar-tools.js";
import {registerNodeTools, registerNodeWriteTools} from "./tools/node-tools.js";
import {registerSearchTools} from "./tools/search-tools.js";

/** Which tools a connection gets: a read-only one lists and runs only the tools that read the outline. */
export interface ToolAccess
{
	readOnly?: boolean;
}

/** The ops a read-only connection may run; `nodes.resolve` only without `createPath`. */
const READ_OPS: ReadonlySet<OpName> = new Set<OpName>([
	"nodes.resolve",
	"nodes.readTree",
	"search.text",
	"cache.status",
	"changes.list",
	"calendar.day",
]);

function isReadCall(op: OpName, input: unknown): boolean
{
	if (!READ_OPS.has(op))
	{
		return false;
	}
	return !(typeof input === "object" && input !== null && "createPath" in input && input.createPath === true);
}

/** A store that refuses every op that could write, so a read tool with a write option (calendar ensure) cannot write. */
function readOnlyStore(store: StoreClient): StoreClient
{
	return {
		async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>>
		{
			if (!isReadCall(op, input))
			{
				return {
					ok: false,
					status: 403,
					body:
					{
						error: `Read-only access: ${op} needs the mcp:write scope`,
					},
				};
			}
			return store.call(op, input);
		},
	};
}

/**
 * Every OutlineDB tool, each a thin adapter over the store's ops. The stdio host passes an in-process store over the
 * local cache; a Worker can pass a Durable Object's store client. With `readOnly`, the write tools are not registered
 * and the store refuses write ops.
 */
export function registerOutlineTools(server: McpServer, store: StoreClient, access: ToolAccess = {}): void
{
	const scoped = access.readOnly === true ? readOnlyStore(store) : store;
	registerNodeTools(server, scoped);
	if (access.readOnly !== true)
	{
		registerNodeWriteTools(server, scoped);
	}
	registerCalendarTools(server, scoped);
	registerCacheTools(server, scoped);
	registerSearchTools(server, scoped);
}
