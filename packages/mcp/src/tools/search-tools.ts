import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {StoreClient} from "@workflowy/web/node-host";
import {z} from "zod";
import {resolve} from "./resolve.js";
import {errorResult, jsonResult, nodeUrl, opError, textResult} from "./results.js";

export function registerSearchTools(server: McpServer, store: StoreClient): void {
	server.registerTool(
		"workflowy_search",
		{
			description:
				"Search for nodes by text query (supports operators such as is:complete, is:incomplete and quoted phrases)",
			inputSchema: {
				query: z.string().describe("Text to search for in node names and notes"),
				limit: z.number().optional().default(20).describe("Maximum number of results to return"),
				offset: z.number().optional().default(0).describe("Number of ranked results to skip, for paging"),
				incomplete: z
					.boolean()
					.optional()
					.default(false)
					.describe("Only return incomplete (not completed) nodes"),
				parentId: z.string().optional().describe("Only search the descendants of this node"),
				parentPath: z
					.string()
					.optional()
					.describe("Comma-separated path to the node whose descendants to search"),
			},
		},
		async ({query, limit, offset, incomplete, parentId, parentPath}) => {
			if (!query.trim()) {
				return errorResult("Query cannot be empty");
			}
			let scope: string | undefined;
			if (parentId || parentPath) {
				const resolved = await resolve(store, {id: parentId, path: parentPath, parent: true});
				if (!resolved.ok) {
					return resolved.error;
				}
				scope = resolved.id ?? undefined;
			}
			const found = await store.call("search.text", {
				query: incomplete ? `${query} is:incomplete` : query,
				limit,
				offset,
				...(scope === undefined ? {} : {parentId: scope}),
			});
			if (!found.ok) {
				return opError(found);
			}
			const {results} = found.value;
			if (results.length === 0) {
				return textResult(`No results found for: ${query}`);
			}
			return jsonResult(results.map((result) => ({...result, url: nodeUrl(result.id)})));
		},
	);
}
