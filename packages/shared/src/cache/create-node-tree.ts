import {z} from "zod";
import type {WorkflowyWriteThroughClient} from "./workflowy-write-through-client.js";

/**
 * A node in a create-tree spec, with recursively nested children. The recursive
 * `children` field uses a Zod v4 getter so the schema is the single source of
 * truth and `z.infer` resolves the recursion. Reusable as an MCP input schema.
 */
export const NodeTreeSpecSchema = z.object(
	{
		name: z.string(),
		note: z.string().optional(),
		layoutMode: z.string().optional(),
		get children(): z.ZodOptional<z.ZodArray<typeof NodeTreeSpecSchema>>
		{
			return z.array(NodeTreeSpecSchema).optional();
		},
	},
);

export type NodeTreeSpec = z.infer<typeof NodeTreeSpecSchema>;

/** The created root node and all its descendants. */
export interface CreatedNodeTree
{
	id: string;
	name: string;
	createdAt: number;
	children: CreatedNodeTree[];
}

/** The minimal write-through surface {@link createNodeTree} needs (fakeable in tests). */
export type TreeWriteClient = Pick<WorkflowyWriteThroughClient, "createNode">;

/**
 * Create a tree of nodes depth-first through the write-through client (API first,
 * then cache). The root takes `position`; children always use `'bottom'` so the
 * spec's array order is preserved. Shared by the CLI, and reusable by MCP/web —
 * both already hold a {@link WorkflowyWriteThroughClient}.
 */
export async function createNodeTree(
	spec: NodeTreeSpec,
	parentId: string | null,
	client: TreeWriteClient,
	position?: "top" | "bottom",
): Promise<CreatedNodeTree>
{
	const node = await client.createNode(
		{
			parent_id: parentId,
			name: spec.name,
			note: spec.note,
			layoutMode: spec.layoutMode,
			position,
		},
	);

	const children: CreatedNodeTree[] = [];
	for (const child of spec.children ?? [])
	{
		children.push(await createNodeTree(child, node.id, client, "bottom"));
	}

	return {
		id: node.id,
		name: node.name,
		createdAt: node.createdAt,
		children,
	};
}
