import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import type {StoreClient} from "@workflowy/web/node-host";
import {z} from "zod";
import {resolve} from "./resolve.js";
import {errorResult, jsonResult, nodeUrl, opError, textResult} from "./results.js";

/** A node op's id: `nodes.resolve` without `parent` never answers Home (`null`). */
function nodeIdOf(id: string | null): string {
	return id ?? "home";
}

interface NodeTreeSpec {
	name: string;
	note?: string | undefined;
	children?: NodeTreeSpec[] | undefined;
}

const NodeTreeSpecSchema: z.ZodType<NodeTreeSpec> = z.object({
	name: z.string().describe("Name of the child node"),
	note: z.string().optional().describe("Note for the child node"),
	get children() {
		return z.array(NodeTreeSpecSchema).optional().describe("Its own children, created in order");
	},
});

interface CreatedTree {
	id: string;
	name: string;
	url: string;
	children: CreatedTree[];
}

type CreatedChildren = {ok: true; children: CreatedTree[]} | {ok: false; error: CallToolResult};

/** Create `specs` in order at the bottom of `parentId`, each subtree depth-first. */
async function createChildren(store: StoreClient, parentId: string, specs: NodeTreeSpec[]): Promise<CreatedChildren> {
	const children: CreatedTree[] = [];
	for (const spec of specs) {
		const created = await store.call("nodes.create", {
			parent_id: parentId,
			name: spec.name,
			...(spec.note === undefined ? {} : {note: spec.note}),
		});
		if (!created.ok) {
			return {ok: false, error: opError(created)};
		}
		const {id, name} = created.value.node;
		const grandchildren = await createChildren(store, id, spec.children ?? []);
		if (!grandchildren.ok) {
			return grandchildren;
		}
		children.push({id, name: name ?? "", url: nodeUrl(id), children: grandchildren.children});
	}
	return {ok: true, children};
}

/** The tools that read the outline. */
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
		"workflowy_node_changes",
		{
			description:
				"Nodes added, deleted, edited, moved, completed or uncompleted since a cutoff: a flat change list, the changes as a tree with unchanged ancestors as context, and a summary",
			inputSchema: {
				since: z
					.string()
					.optional()
					.default("1d")
					.describe("Duration (e.g. 12h, 2d, 1w) or ISO date to report changes since"),
			},
		},
		async ({since}) => {
			const changes = await store.call("changes.list", {since});
			return changes.ok ? jsonResult(changes.value) : opError(changes);
		},
	);
}

/** The tools that change the outline; a read-only connection does not get them. */
export function registerNodeWriteTools(server: McpServer, store: StoreClient): void {
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
				children: z
					.array(NodeTreeSpecSchema)
					.optional()
					.describe(
						"Child nodes to create under the new node, in order, each with optional children of its own",
					),
			},
		},
		async ({parentId, parentPath, name, note, position, createPath, children}) => {
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
			const {node, warning} = created.value;
			const tree = children === undefined ? undefined : await createChildren(store, node.id, children);
			if (tree !== undefined && !tree.ok) {
				return tree.error;
			}
			return jsonResult({
				id: node.id,
				name: node.name,
				createdAt: node.createdAt === null ? null : new Date(node.createdAt * 1000).toISOString(),
				url: nodeUrl(node.id),
				...(warning === undefined ? {} : {warning}),
				...(tree === undefined ? {} : {children: tree.children}),
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
				clearNote: z.boolean().optional().default(false).describe("Clear the node's note"),
			},
		},
		async ({id, path, name, note: newNote, clearNote}) => {
			if (!id && !path) {
				return errorResult("Either id or path is required");
			}
			if (clearNote && newNote !== undefined) {
				return errorResult("note and clearNote cannot be used together");
			}
			const note = clearNote ? "" : newNote;
			if (!name && note === undefined) {
				return errorResult("At least one of name, note or clearNote must be provided");
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

	server.registerTool(
		"workflowy_node_mirror",
		{
			description:
				"Create a live mirror of a node under a parent (a mirror of a mirror mirrors its original); needs the internal API",
			inputSchema: {
				nodeId: z.string().optional().describe("ID of the node to mirror"),
				nodePath: z.string().optional().describe("Comma-separated path to the node to mirror"),
				parentId: z.string().optional().describe('Parent ID, a system target, or "home" for the top level'),
				parentPath: z.string().optional().describe("Comma-separated path to the parent"),
				position: z.enum(["top", "bottom"]).optional().default("top").describe("Position within the parent"),
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
			const mirrored = await store.call("nodes.mirror", {
				item_ids: [id],
				parent_id: parent.id,
				...(position === "top" ? {index: 0} : {}),
			});
			if (!mirrored.ok) {
				return opError(mirrored);
			}
			const [mirror] = mirrored.value.nodes;
			if (mirror === undefined) {
				return errorResult(`Mirror of ${id} was not created`);
			}
			return jsonResult({
				mirrorId: mirror.id,
				originId: mirror.originalNodeId ?? id,
				parentId: parent.id,
				url: nodeUrl(mirror.id),
			});
		},
	);
}
