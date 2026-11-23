import {z} from "zod";
import {ancestorChain} from "@outlinedb/shared/cache";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";
import {planSwapOrigin} from "../../swap-origin.js";
import {MAX_COPY_DEPTH, MAX_COPY_ITEMS, copySubtree} from "../copy-tree.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api.js";
import type {ServerContext} from "../context.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import {applyMirrorExpansion} from "./expansion.js";
import {DetachMirrorResponseSchema, NodeListSchema, SwapMirrorOriginResponseSchema} from "./schemas.js";
import
{
	countChildren,
	getAdapter,
	getNodeWriter,
	localDeletePlan,
	openCopies,
	originalsWithMirrors,
	IndexSchema,
	NodeIdsSchema,
	ParentIdSchema,
	parseParent,
	readNodeDto,
	resolveMirrorToOriginal,
	resolveNodeId,
} from "./nodes-shared.js";

const DETACH_TOO_BIG = `Detaching mirror subtrees containing more than ${MAX_COPY_ITEMS} items is not supported.`;
const DETACH_TOO_DEEP = `Detaching mirror subtrees more than ${MAX_COPY_DEPTH} levels deep is not supported.`;

// POST /api/v1/nodes/mirror - Mirror items under a parent, in order at consecutive indexes
export const nodesMirror = defineOp(
	{
		input: z.object(
			{
				item_ids: NodeIdsSchema,
				parent_id: ParentIdSchema,
				index: IndexSchema,
			},
		),
		output: NodeListSchema,
		async run(ctx, body)
		{
			const parent = parseParent(ctx, body.parent_id);
			if (!parent.ok)
			{
				return fail(
					parent.status,
					{
						error: parent.error,
					},
				);
			}
			const originals: string[] = [];
			const sourceRows: string[] = [];
			for (const raw of body.item_ids)
			{
				if (raw === "None" || raw === "" || raw === HOME_TARGET)
				{
					return fail(
						400,
						{
							error: "Cannot mirror Home",
						},
					);
				}
				const resolved = resolveNodeId(ctx, raw);
				if (resolved === null)
				{
					return fail(
						404,
						{
							error: `Node not found: ${raw}`,
						},
					);
				}
				sourceRows.push(resolved);
				originals.push(resolveMirrorToOriginal(ctx, resolved));
			}
			// A mirror parent writes into its original's child list.
			const parentId = parent.parentId === null ? null : resolveMirrorToOriginal(ctx, parent.parentId);
			// The parent and each of its ancestors, which no source may be (an uncached parent still counts).
			const lineage = new Set(
				ancestorChain(
					parentId,
					(id) =>
						ctx.cacheService.getNode(id) ??
						{
							id,
							parentId: null,
						},
				).map((node) => node.id),
			);
			if (originals.some((id) => lineage.has(id)))
			{
				return fail(
					400,
					{
						error: "Cannot mirror an item into itself",
					},
				);
			}
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					503,
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				);
			}
			if (parentId !== null && !ctx.cacheService.getNode(parentId))
			{
				return fail(
					404,
					{
						error: "Parent node not found",
					},
				);
			}
			const {ids: mirrorIds} = writer.local.createMirrorsAt(
				{
					originalIds: originals,
					parentId,
					index: body.index ?? countChildren(ctx, parentId),
				},
			);
			// A mirror's new mirror opens like its source row (upstream `mirrorProjectTree`: `expanded:
			// source.isExpanded`), locally with an account outbox row. A standalone mirror starts collapsed.
			const adapter = writer.mode === "mirror" ? getAdapter(ctx) : undefined;
			if (adapter)
			{
				const isExpanded = adapter.expansionTest();
				const opened = Object.fromEntries(
					mirrorIds.flatMap((mirrorId, offset) =>
						isExpanded(sourceRows[offset] ?? "") ? [[upstreamExpansionKey(mirrorId), true] as const] : [],
					),
				);
				if (Object.keys(opened).length > 0)
				{
					applyMirrorExpansion(ctx, opened);
				}
			}
			return mirroredNodes(ctx, mirrorIds);
		},
	},
);

async function mirroredNodes(ctx: ServerContext, mirrorIds: string[])
{
	const nodes = (await Promise.all(mirrorIds.map(async (id) => readNodeDto(ctx, id)))).filter(
		(node) => node !== undefined,
	);
	return ok(
		toJson(
			{
				nodes,
			},
		),
		{
			created: true,
		},
	);
}

// POST /api/v1/nodes/:id/detach-mirror - Replace a mirror root (a mirror, or an original that has mirrors) with a copy
export const nodesDetachMirror = defineOp(
	{
		input: z.object(
			{
				id: z.string(),
			},
		),
		output: DetachMirrorResponseSchema,
		async run(ctx, {id: rawId})
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					503,
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				);
			}
			const id = resolveNodeId(ctx, rawId);
			const node = id === null ? undefined : ctx.cacheService.getNode(id);
			if (id === null || node === undefined)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}
			const originalId = resolveMirrorToOriginal(ctx, id);
			const isOriginal = originalId === id;
			if (isOriginal && !originalsWithMirrors(ctx, [id]).has(id))
			{
				return fail(
					400,
					{
						error: "Node is not a mirror",
					},
				);
			}
			// A mirror has no completion of its own, so its copy is open; an original keeps its own.
			const copied = await copySubtree(
				ctx.cacheService,
				originalId,
				{
					rootCompleted: isOriginal && (node.completedAt ?? null) !== null,
					mirrorOriginals: true,
					originalsWithMirrors: (ids) => originalsWithMirrors(ctx, ids),
				},
			);
			if (copied === undefined)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}
			if (!copied.ok)
			{
				return fail(
					400,
					{
						error: copied.reason === "tooMany" ? DETACH_TOO_BIG : DETACH_TOO_DEEP,
					},
				);
			}
			const copyId = writer.local.detachMirror(id, copied.tree, await localDeletePlan(ctx, id));
			// A mirror opens the copies of expanded rows, locally with account outbox rows; a standalone copy starts collapsed.
			const adapter = writer.mode === "mirror" ? getAdapter(ctx) : undefined;
			if (adapter)
			{
				openCopies(
					ctx,
					adapter,
					copied.sourceToNew,
					{
						original: originalId,
						row: id,
					},
				);
			}
			return detachedCopy(ctx, copyId);
		},
	},
);

async function detachedCopy(ctx: ServerContext, copyId: string | undefined)
{
	const copy = copyId === undefined ? undefined : await readNodeDto(ctx, copyId);
	return ok(
		toJson(
			{
				node: copy ?? null,
			},
		),
		{
			created: true,
		},
	);
}

// POST /api/v1/nodes/:id/swap-mirror-origin - Make a mirror the origin: it and its original exchange slots
export const nodesSwapMirrorOrigin = defineOp(
	{
		input: z.object(
			{
				id: z.string(),
			},
		),
		output: SwapMirrorOriginResponseSchema,
		run(ctx, {id: rawId})
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					503,
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				);
			}
			const id = resolveNodeId(ctx, rawId);
			const node = id === null ? undefined : ctx.cacheService.getNode(id);
			if (id === null || node === undefined)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}
			const originalId = resolveMirrorToOriginal(ctx, id);
			if (originalId === id)
			{
				if (originalsWithMirrors(ctx, [id]).has(id))
				{
					return ok(
						{
							warning: "This item is already the origin.",
						},
					);
				}
				return fail(
					400,
					{
						error: "Node is not a mirror",
					},
				);
			}
			const original = ctx.cacheService.getNode(originalId);
			if (original === undefined)
			{
				return fail(
					404,
					{
						error: "Original not found",
					},
				);
			}
			// The original would land inside its own subtree.
			if (
				ancestorChain(node.parentId, (current) => ctx.cacheService.getNode(current)).some(
					(ancestor) => ancestor.id === originalId,
				)
			)
			{
				return fail(
					400,
					{
						error: "Cannot swap a mirror that sits inside its own original",
					},
				);
			}
			const orders = new Map<string | null, string[]>(
				[node.parentId, original.parentId].map((parentId) => [
					parentId,
					ctx.cacheService.getChildren(parentId).map((child) => child.id),
				]),
			);
			const moves = planSwapOrigin(
				orders,
				{
					id,
					parentId: node.parentId,
				},
				{
					id: originalId,
					parentId: original.parentId,
				},
			);
			writer.local.moveBlocks(
				moves.map((move) => (
				{
					ids: [move.id],
					parentId: move.parentId,
					index: move.index,
				})),
			);
			return ok(
				{
					swapped:
					{
						mirrorId: id,
						originalId,
					},
				},
			);
		},
	},
);
