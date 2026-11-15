import {z} from "zod";
import {LocalTreeWriter, ancestorChain} from "@outlinedb/shared/cache";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {planSwapOrigin} from "../../swap-origin.js";
import {MAX_COPY_ITEMS, copySubtree} from "../copy-tree.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api.js";
import type {ServerContext} from "../context.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import {DetachMirrorResponseSchema, NodeListSchema, SwapMirrorOriginResponseSchema} from "./schemas.js";
import
{
	adapterParent,
	countChildren,
	getAdapter,
	getWriteClient,
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
			if (ctx.mode === "standalone")
			{
				if (parentId !== null && !ctx.cacheService.getNode(parentId))
				{
					return fail(
						404,
						{
							error: "Parent node not found",
						},
					);
				}
				// Expansion is upstream state; a standalone mirror starts collapsed, like a standalone copy.
				const {ids} = new LocalTreeWriter(ctx.db).createMirrorsAt(
					{
						originalIds: originals,
						parentId,
						index: body.index ?? countChildren(ctx, parentId),
					},
				);
				return mirroredNodes(ctx, ids);
			}
			const adapter = getAdapter(ctx);
			if (!adapter)
			{
				return fail(
					503,
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				);
			}
			const {mirrors} = await adapter.createMirrorsAt(
				{
					originalIds: originals,
					parentId: adapterParent(parentId),
					index: body.index ?? countChildren(ctx, parentId),
				},
			);
			const mirrorIds = mirrors.map((mirror) => mirror.mirrorId);
			// A new mirror opens like its source row (upstream `mirrorProjectTree`: `expanded: source.isExpanded`).
			const isExpanded = adapter.expansionTest();
			const opened = Object.fromEntries(
				mirrorIds.flatMap((mirrorId, offset) =>
					isExpanded(sourceRows[offset] ?? "") ? [[mirrorId, true] as const] : [],
				),
			);
			if (Object.keys(opened).length > 0)
			{
				await adapter.setExpanded(opened);
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
			const standalone = ctx.mode === "standalone";
			const client = standalone ? undefined : getWriteClient(ctx);
			const adapter = standalone ? undefined : getAdapter(ctx);
			if (!standalone && (!client || !adapter))
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
						error: DETACH_TOO_BIG,
					},
				);
			}
			if (!client || !adapter)
			{
				const copyId = new LocalTreeWriter(ctx.db).detachMirror(
					id,
					copied.tree,
					await localDeletePlan(ctx, id),
				);
				return detachedCopy(ctx, copyId);
			}
			const index = Math.max(
				ctx.cacheService.getChildren(node.parentId).findIndex((sibling) => sibling.id === id),
				0,
			);
			const {ids} = await adapter.createTreesAt(
				{
					parentId: adapterParent(node.parentId),
					index,
					trees: [copied.tree],
				},
			);
			await openCopies(
				adapter,
				copied.sourceToNew,
				{
					original: originalId,
					row: id,
				},
			);
			await client.deleteNode(id);
			return detachedCopy(ctx, ids[0]);
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
		async run(ctx, {id: rawId})
		{
			const standalone = ctx.mode === "standalone";
			const adapter = standalone ? undefined : getAdapter(ctx);
			if (!standalone && !adapter)
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
			if (adapter)
			{
				for (const move of moves)
				{
					await adapter.moveTo(
						{
							ids: [move.id],
							parentId: adapterParent(move.parentId),
							index: move.index,
						},
					);
				}
			}
			else
			{
				new LocalTreeWriter(ctx.db).moveBlocks(
					moves.map((move) => (
					{
						ids: [move.id],
						parentId: move.parentId,
						index: move.index,
					})),
				);
			}
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
