import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {registerWorkflowyTools} from "@workflowy/mcp/tools";
import type {ToolAccess} from "@workflowy/mcp/tools";
import {storeClient} from "./store-client";

/**
 * Serves one MCP request for user `userId`'s outline: a fresh server and stateless Streamable HTTP transport per request, so no
 * session state outlives it. Stateless mode has no server-to-client stream, so only POST is served.
 */
export async function mcpHandler(
	request: Request,
	userId: string,
	env: Pick<Env, "USER_STORE">,
	access: ToolAccess = {},
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", {status: 405, headers: {allow: "POST"}});
	}
	const store = storeClient(env.USER_STORE.getByName(userId));
	const server = new McpServer({name: "workflowy", version: "0.1.0"});
	registerWorkflowyTools(server, store, access);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return transport.handleRequest(request);
}
