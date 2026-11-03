import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {StoreClient} from "@workflowy/web/node-host";
import {z} from "zod";
import {errorResult, jsonResult, nodeUrl, opError, textResult} from "./results.js";

export function registerSearchTools(server: McpServer, store: StoreClient): void {
	server.registerTool(
		"workflowy_search",
		{
			description: "Search for nodes by text query",
			inputSchema: {
				query: z.string().describe("Text to search for in node names and notes"),
				limit: z.number().optional().default(20).describe("Maximum number of results to return"),
			},
		},
		async ({query, limit}) => {
			if (!query.trim()) {
				return errorResult("Query cannot be empty");
			}
			const found = await store.call("search.text", {query, limit, offset: 0});
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
