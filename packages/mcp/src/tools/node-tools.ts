import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {StoreClient} from "@workflowy/web/node-host";
import {z} from "zod";
import {resolve} from "./resolve.js";
import {errorResult, jsonResult, nodeUrl, opError, textResult} from "./results.js";

/** A node op's id: `nodes.resolve` without `parent` never answers Home (`null`). */
function nodeIdOf(id: string | null): string {
	return id ?? "home";
}

export function registerNodeTools(server: McpServer, store: StoreClient): void {
	server.registerTool(
		"workflowy_node_get",
		{
			description: "Get a node by ID or path",
			inputSchema: {
				id: z.string().optional().describe("Node ID"),
				path: z.string().optional().describe("Comma-separated path to node"),
			},
		},
		async ({id, path}) => {
			if (!id && !path) {
				return errorResult("Either id or path is required");
			}
			const resolved = await resolve(store, {id, path});
			if (!resolved.ok) {
				return resolved.error;
			}
			const nodeId = nodeIdOf(resolved.id);
			const read = await store.call("nodes.readTree", {ids: [nodeId], depth: 0});
			if (!read.ok) {
				return opError(read);
			}
			const [node] = read.value.nodes;
			return node === undefined ? errorResult(`Node not found: ${nodeId}`) : jsonResult(node);
		},
	);

	server.registerTool(
		"workflowy_node_list",
		{
			description: "List children of a node",
			inputSchema: {
				parentId: z.string().optional().describe("Parent node ID (null for root)"),
				parentPath: z.string().optional().describe("Comma-separated path to parent"),
				depth: z.number().optional().default(1).describe("Depth to recurse (1 = immediate children only)"),
			},
		},
		async ({parentId, parentPath, depth}) => {
			let resolvedParentId: string | null = null;
			if (parentId || parentPath) {
				const resolved = await resolve(store, {id: parentId, path: parentPath, parent: true});
				if (!resolved.ok) {
					return resolved.error;
				}
				resolvedParentId = resolved.id;
			}
			// This tool's `depth` counts levels of nodes returned (1 = immediate children only),
			// whereas readTree's depth counts levels below each returned node, so subtract one.
			const read = await store.call("nodes.readTree", {
				parentId: resolvedParentId,
				depth: Math.max(0, depth - 1),
			});
			return read.ok ? jsonResult(read.value.nodes) : opError(read);
		},
	);

	server.registerTool(
		"workflowy_node_create",
		{
			description: "Create a new node",
			inputSchema: {
				parentId: z.string().optional().describe('Parent node ID or system target (e.g., "inbox")'),
				parentPath: z.string().optional().describe("Comma-separated path to parent"),
				name: z.string().describe("Name of the new node"),
				note: z.string().optional().describe("Note/description for the node"),
				position: z.enum(["top", "bottom"]).optional().describe("Position among siblings"),
				createPath: z
					.boolean()
					.optional()
					.default(false)
					.describe("Create missing parent path segments (like mkdir -p)"),
			},
		},
		async ({parentId, parentPath, name, note, position, createPath}) => {
			if (!parentId && !parentPath) {
				return errorResult("Either parentId or parentPath is required");
			}
			const parent = await resolve(store, {id: parentId, path: parentPath, parent: true, createPath});
			if (!parent.ok) {
				return parent.error;
			}
			const created = await store.call("nodes.create", {
				parent_id: parent.id,
				name,
				...(note === undefined ? {} : {note}),
				...(position === "top" ? {index: 0} : {}),
			});
			if (!created.ok) {
				return opError(created);
			}
			const {node} = created.value;
			return jsonResult({
				id: node.id,
				name: node.name,
				createdAt: node.createdAt === null ? null : new Date(node.createdAt * 1000).toISOString(),
				url: nodeUrl(node.id),
			});
		},
	);

	server.registerTool(
		"workflowy_node_update",
		{
			description: "Update an existing node",
			inputSchema: {
				id: z.string().optional().describe("Node ID"),
				path: z.string().optional().describe("Comma-separated path to node"),
				name: z.string().optional().describe("New name for the node"),
				note: z.string().optional().describe("New note for the node"),
			},
		},
		async ({id, path, name, note}) => {
			if (!id && !path) {
				return errorResult("Either id or path is required");
			}
			if (!name && note === undefined) {
				return errorResult("At least one of name or note must be provided");
			}
			const resolved = await resolve(store, {id, path});
			if (!resolved.ok) {
				return resolved.error;
			}
			const updated = await store.call("nodes.update", {
				id: nodeIdOf(resolved.id),
				...(name ? {name} : {}),
				...(note === undefined ? {} : {note}),
			});
			if (!updated.ok) {
				return opError(updated);
			}
			const {node} = updated.value;
			return jsonResult({id: node.id, name: node.name, note: node.note});
		},
	);

	server.registerTool(
		"workflowy_node_delete",
		{
			description: "Delete a node",
			inputSchema: {
				id: z.string().optional().describe("Node ID"),
				path: z.string().optional().describe("Comma-separated path to node"),
			},
		},
		async ({id, path}) => {
			if (!id && !path) {
				return errorResult("Either id or path is required");
			}
			const resolved = await resolve(store, {id, path});
			if (!resolved.ok) {
				return resolved.error;
			}
			const nodeId = nodeIdOf(resolved.id);
			const deleted = await store.call("nodes.delete", {id: nodeId});
			return deleted.ok ? textResult(`Successfully deleted node: ${nodeId}`) : opError(deleted);
		},
	);

	for (const [operation, verb, description] of [
		["complete", "completed", "Mark a node as completed"],
		["uncomplete", "uncompleted", "Mark a node as not completed"],
	] as const) {
		server.registerTool(
			`workflowy_node_${operation}`,
			{
				description,
				inputSchema: {
					id: z.string().optional().describe("Node ID"),
					path: z.string().optional().describe("Comma-separated path to node"),
				},
			},
			async ({id, path}) => {
				if (!id && !path) {
					return errorResult("Either id or path is required");
				}
				const resolved = await resolve(store, {id, path});
				if (!resolved.ok) {
					return resolved.error;
				}
				const changed = await store.call(`nodes.${operation}`, {id: nodeIdOf(resolved.id)});
				if (!changed.ok) {
					return opError(changed);
				}
				const {node} = changed.value;
				return textResult(`Successfully ${verb} node: ${node.name} (${node.id})`);
			},
		);
	}

	server.registerTool(
		"workflowy_node_move",
		{
			description: "Move a node to a new parent",
			inputSchema: {
				nodeId: z.string().optional().describe("ID of node to move"),
				nodePath: z.string().optional().describe("Comma-separated path to node to move"),
				parentId: z.string().optional().describe("Destination parent ID or system target"),
				parentPath: z.string().optional().describe("Comma-separated path to destination parent"),
				position: z.enum(["top", "bottom"]).optional().describe("Position within destination"),
			},
		},
		async ({nodeId, nodePath, parentId, parentPath, position}) => {
			if (!nodeId && !nodePath) {
				return errorResult("Either nodeId or nodePath is required");
			}
			if (!parentId && !parentPath) {
				return errorResult("Either parentId or parentPath is required");
			}
			const node = await resolve(store, {id: nodeId, path: nodePath});
			if (!node.ok) {
				return node.error;
			}
			const parent = await resolve(store, {id: parentId, path: parentPath, parent: true});
			if (!parent.ok) {
				return parent.error;
			}
			const id = nodeIdOf(node.id);
			const moved = await store.call("nodes.moveOne", {
				id,
				parent_id: parent.id,
				...(position === "top" ? {index: 0} : {}),
			});
			if (!moved.ok) {
				return opError(moved);
			}
			const name = moved.value.nodes.find((sibling) => sibling.id === id)?.name ?? "";
			return textResult(`Successfully moved node: ${name} (${id})`);
		},
	);
}
