import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createServerContext, inProcessStore} from "@outlinedb/web/node-host";
import {registerOutlineTools} from "./register.js";

process.title = "outlinedb-mcp";

const server = new McpServer(
	{
		name: "outlinedb",
		version: "0.1.0",
	},
);

registerOutlineTools(server, inProcessStore(createServerContext()));

const transport = new StdioServerTransport();
await server.connect(transport);
