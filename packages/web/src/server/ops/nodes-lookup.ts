import {z} from "zod";
import {NodeTreeReader} from "@outlinedb/shared/cache";
import {resolveNodeId, resolveOrCreateNodePath, resolveParent} from "@outlinedb/shared/utils";
import {defineOp, fail, ok, toJson} from "./define.js";
import {getApiClient} from "./nodes-shared.js";

const API_KEY_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";

/**
 * A node id from a full or short `id`, or a comma-separated `path` (the cache first, then the public API), the way
 * the CLI and MCP tools address nodes. With `parent`, `"home"` resolves to `null` (Home) and a system target such as
 * `"inbox"` passes through; with `createPath` as well, missing path segments are created (like `mkdir -p`).
 */
export const nodesResolve = defineOp({
	input: z.object({
		id: z.string().optional(),
		path: z.string().optional(),
		parent: z.boolean().optional(),
		createPath: z.boolean().optional(),
	}),
	output: z.strictObject({id: z.string().nullable()}),
	async run(ctx, {id, path, parent, createPath}) {
		const apiClient = getApiClient(ctx);
		if (!apiClient) {
			return fail(500, {error: API_KEY_REQUIRED});
		}
		try {
			if (parent === true && createPath === true && path !== undefined) {
				return ok({id: await resolveOrCreateNodePath(path, ctx.cacheService, apiClient)});
			}
			const resolved = await (parent === true
				? resolveParent({id, path}, ctx.cacheService, apiClient)
				: resolveNodeId({id, path}, ctx.cacheService, apiClient));
			return ok({id: resolved});
		} catch (error) {
			return fail(404, {error: error instanceof Error ? error.message : String(error)});
		}
	},
});

/** A tree node as `NodeTreeReader` returns it (the CLI's `node get`/`list` JSON), with dates as ISO strings. */
const NodeTreeSchema = z.json();

/**
 * Nodes in the CLI's `NodeTreeReader` shape: the `ids` themselves, or else `parentId`'s children (Home's when it is
 * null or omitted), each with `depth` levels of descendants (0 = none).
 */
export const nodesReadTree = defineOp({
	input: z.object({
		ids: z.array(z.string()).optional(),
		parentId: z.string().nullable().optional(),
		depth: z.number().int().nonnegative().optional(),
	}),
	output: z.strictObject({nodes: z.array(NodeTreeSchema)}),
	async run(ctx, {ids, parentId, depth = 0}) {
		const reader = new NodeTreeReader(ctx.cacheService);
		const nodes = await (ids === undefined
			? reader.readChildren(parentId ?? null, {depth})
			: reader.readNodes(ids, {depth}));
		return ok(toJson({nodes}));
	},
});
