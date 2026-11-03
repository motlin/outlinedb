import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createServerContext, inProcessStore} from "@workflowy/web/node-host";
import {registerWorkflowyTools} from "./register.js";

process.title = "workflowy-mcp";

const server = new McpServer({
	name: "workflowy",
	version: "0.1.0",
});

registerWorkflowyTools(server, inProcessStore(createServerContext()));

const transport = new StdioServerTransport();
await server.connect(transport);
