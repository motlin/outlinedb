import {z} from "zod";

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
