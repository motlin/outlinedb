import {z} from "zod";
import {NodeTreeReader} from "@outlinedb/shared/cache";
import {resolveNodeId, resolveParent} from "@outlinedb/shared/utils";
import {defineOp, fail, ok, toJson} from "./define.js";
import type {ServerContext} from "../context.js";
import {getApiClient, getNodeWriter} from "./nodes-shared.js";
import type {NodeWriter} from "./nodes-shared.js";

const API_KEY_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";

/**
 * The node at a comma-separated path, each missing segment created under the one before it (a missing first segment
 * at Home), as local writes: the local tables are the truth in both modes, and a mirror's drain delivers the creates.
 */
function createPathLocally(ctx: ServerContext, writer: NodeWriter, path: string): string | null
{
	const parts = path.split(",").map((part) => part.trim());
	let parentId: string | null = null;
	for (const [index, name] of parts.entries())
	{
		parentId =
			ctx.cacheService.findNodeByPath(parts.slice(0, index + 1))?.id ??
			writer.local.createAt(
				{
					parentId,
					name,
				},
			).id;
	}
	return parentId;
}

/**
 * A node id from a full or short `id`, or a comma-separated `path` (the cache first, then the public API), the way
 * the CLI and MCP tools address nodes. With `parent`, `"home"` resolves to `null` (Home) and a system target such as
 * `"inbox"` passes through; with `createPath` as well, missing path segments are created (like `mkdir -p`).
 */
export const nodesResolve = defineOp(
	{
		input: z.object(
			{
				id: z.string().optional(),
				path: z.string().optional(),
				parent: z.boolean().optional(),
				createPath: z.boolean().optional(),
			},
		),
		output: z.strictObject(
			{
				id: z.string().nullable(),
			},
		),
		async run(ctx, {id, path, parent, createPath})
		{
			if (parent === true && createPath === true && path !== undefined)
			{
				const writer = getNodeWriter(ctx);
				return writer === undefined
					? fail(
							500,
							{
								error: API_KEY_REQUIRED,
							},
						)
					: ok(
							{
								id: createPathLocally(ctx, writer, path),
							},
						);
			}
			// Mirror mode falls back to workflowy.com on a local miss; standalone answers from the local tables alone.
			const apiClient = getApiClient(ctx);
			try
			{
				const resolved = await (parent === true
					? resolveParent(
							{
								id,
								path,
							},
							ctx.cacheService,
							apiClient,
						)
					: resolveNodeId(
							{
								id,
								path,
							},
							ctx.cacheService,
							apiClient,
						));
				return ok(
					{
						id: resolved,
					},
				);
			}
			catch (error)
			{
				return fail(
					404,
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		},
	},
);

/** A tree node as `NodeTreeReader` returns it (the CLI's `node get`/`list` JSON), with dates as ISO strings. */
const NodeTreeSchema = z.json();

/**
 * Nodes in the CLI's `NodeTreeReader` shape: the `ids` themselves, or else `parentId`'s children (Home's when it is
 * null or omitted), each with `depth` levels of descendants (0 = none).
 */
export const nodesReadTree = defineOp(
	{
		input: z.object(
			{
				ids: z.array(z.string()).optional(),
				parentId: z.string().nullable().optional(),
				depth: z.number().int().nonnegative().optional(),
			},
		),
		output: z.strictObject(
			{
				nodes: z.array(NodeTreeSchema),
			},
		),
		async run(ctx, {ids, parentId, depth = 0})
		{
			const reader = new NodeTreeReader(ctx.cacheService);
			const nodes = await (ids === undefined
				? reader.readChildren(
						parentId ?? null,
						{
							depth,
						},
					)
				: reader.readNodes(
						ids,
						{
							depth,
						},
					));
			return ok(
				toJson(
					{
						nodes,
					},
				),
			);
		},
	},
);
