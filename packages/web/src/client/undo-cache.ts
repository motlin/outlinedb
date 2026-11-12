import type {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../node-types.js";
import
{
	nodeKeys,
	patchCachedNode,
	patchMirrors,
	readChildren,
	readNode,
	spliceChildren,
	syncParentFlags,
} from "./node-cache.js";
import {pendingMoves} from "./pending-moves.js";
import {tagColorKeys} from "./tag-color-keys.js";
import type {UndoOp} from "./undo-history.js";
import {HOME_TARGET} from "@outlinedb/shared/types";

/** A removed row with the cached children lists of its subtree, as they stood before the delete. */
interface RemovedRow
{
	row: NodeResponse;
	lists: [ReturnType<typeof nodeKeys.children>, NodeResponse[]][];
}

/** Rows an undo or redo removed, so restoring the same id puts the same row (and its loaded subtree) back at once. */
const removedRows = new Map<string, RemovedRow>();

/** The cached children lists under `nodeId`, its own first; the delete's settle refetch empties them. */
function subtreeLists(queryClient: QueryClient, nodeId: string): RemovedRow["lists"]
{
	const lists: RemovedRow["lists"] = [];
	const visit = (id: string) =>
	{
		const children = readChildren(queryClient, id);
		if (children !== undefined)
		{
			lists.push([nodeKeys.children(id), children]);
			for (const child of children)
			{
				visit(child.id);
			}
		}
	};
	visit(nodeId);
	return lists;
}

/** Drops `nodeId`'s row from every cached children list except `keepParentId`'s. */
function removeRow(queryClient: QueryClient, nodeId: string, keepParentId?: string | null): void
{
	for (const [key, children] of queryClient.getQueriesData<NodeResponse[]>(
		{
			queryKey: [...nodeKeys.all, "children"],
		},
	))
	{
		if (key[2] !== keepParentId && children?.some((child) => child.id === nodeId))
		{
			queryClient.setQueryData(
				key,
				children.filter((child) => child.id !== nodeId),
			);
		}
	}
}

/** Splices `row` into `parentId`'s cached list at the endpoint's slot (seeding a leaf's) and repoints its detail entry. */
function insertRow(queryClient: QueryClient, row: NodeResponse, parentId: string | null, index: number): void
{
	const moved =
	{
		...row,
		parent_id: parentId,
	};
	const target =
		readChildren(queryClient, parentId) ??
		(parentId !== null && readNode(queryClient, parentId)?.hasChildren === false ? [] : undefined);
	if (target !== undefined)
	{
		queryClient.setQueryData<NodeResponse[]>(nodeKeys.children(parentId), spliceChildren(target, moved, index));
	}
	queryClient.setQueryData<NodeResponse>(nodeKeys.detail(row.id), (detail) =>
		detail === undefined
			? detail
			:
				{
					...detail,
					parent_id: parentId,
				},
	);
}

/**
 * Removes a deleted row from the cache at once, keeping it so restoring the same id (the delete's
 * undo) puts the same row back without waiting on a refetch; its parent's children flags follow.
 */
export function removeDeletedRow(queryClient: QueryClient, nodeId: string): void
{
	const row = readNode(queryClient, nodeId);
	if (row !== undefined)
	{
		removedRows.set(
			nodeId,
			{
				row,
				lists: subtreeLists(queryClient, nodeId),
			},
		);
		removeRow(queryClient, nodeId);
		syncParentFlags(queryClient, row.parent_id);
	}
}

function previewOp(queryClient: QueryClient, op: UndoOp): void
{
	switch (op.kind)
	{
		case "tagColor":
		{
			queryClient.setQueryData<Record<string, string>>(tagColorKeys.all, (colors) =>
			{
				const {[op.tag.toLowerCase()]: _dropped, ...rest} = colors ?? {};
				return op.after === null
					? rest
					:
						{
							...rest,
							[op.tag.toLowerCase()]: op.after,
						};
			});
			return;
		}
		case "edit":
			patchCachedNode(queryClient, op.nodeId, (node) => (
			{
				...node,
				[op.field]: op.after,
			}));
			// A mirror's row shows its original's text.
			patchMirrors(queryClient, op.nodeId, (node) => (
			{
				...node,
				[op.field]: op.after,
			}));
			return;
		case "layout":
		{
			const layoutMode = op.after.layoutMode ?? "bullets";
			if (op.nodeId === HOME_TARGET)
			{
				queryClient.setQueryData(
					nodeKeys.home(),
					{
						layoutMode,
					},
				);
				return;
			}
			patchCachedNode(queryClient, op.nodeId, (node) => (
			{
				...node,
				data:
				{
					...node.data,
					layoutMode: op.after.layoutMode,
				},
				numberedStart: op.after.numberedStart,
			}));
			return;
		}
		case "complete":
		case "uncomplete":
		{
			const completedAt = op.kind === "complete" ? Math.floor(Date.now() / 1000) : null;
			patchCachedNode(queryClient, op.nodeId, (node) => (
			{
				...node,
				completedAt,
			}));
			syncParentFlags(queryClient, readNode(queryClient, op.nodeId)?.parent_id ?? null);
			return;
		}
		case "move":
		{
			const row = readNode(queryClient, op.nodeId);
			if (row !== undefined)
			{
				removeRow(queryClient, op.nodeId, op.to.parentId);
				insertRow(queryClient, row, op.to.parentId, op.to.index);
				syncParentFlags(queryClient, row.parent_id);
				syncParentFlags(queryClient, op.to.parentId);
			}
			return;
		}
		case "delete":
			removeDeletedRow(queryClient, op.nodeId);
			return;
		case "create":
		case "undelete":
		default:
		{
			const removed = removedRows.get(op.nodeId);
			if (removed !== undefined)
			{
				removedRows.delete(op.nodeId);
				for (const [key, children] of removed.lists)
				{
					queryClient.setQueryData(key, children);
				}
				insertRow(queryClient, removed.row, op.parentId, op.index);
				syncParentFlags(queryClient, op.parentId);
			}
		}
	}
}

/**
 * Applies a popped (already inverted) undo step to the query cache in replay order, before the
 * server replay, so the outline shows the undo at once as upstream does. Ops whose rows are not
 * cached are left to the refetch that follows the replay.
 */
export function previewUndoOps(queryClient: QueryClient, ops: readonly UndoOp[]): void
{
	for (const op of ops)
	{
		previewOp(queryClient, op);
	}
}

/** Nodes whose text an undo replay will still write, by how many replays name them. */
const textReplays = new Map<string, number>();

/** Whether an undo replay still has to write `nodeId`'s text, so an earlier save's answer must not show its text. */
export function textReplayPending(nodeId: string): boolean
{
	return textReplays.has(nodeId);
}

/** The parents whose children lists `op` changes, read before its preview moves the row. */
function touchedParents(queryClient: QueryClient, op: UndoOp): (string | null)[]
{
	if (op.kind === "tagColor")
	{
		return [];
	}
	const current = readNode(queryClient, op.nodeId)?.parent_id;
	const parents = current === undefined ? [] : [current];
	switch (op.kind)
	{
		case "move":
			return [...parents, op.from.parentId, op.to.parentId];
		case "create":
		case "delete":
		case "undelete":
			return [...parents, op.parentId];
		case "edit":
		case "layout":
		case "complete":
		case "uncomplete":
		default:
			return parents;
	}
}

/**
 * Holds back the server answers that would land over an undo's preview until its replay reaches the
 * server: children reads of the parents it touches wait (as for a move in flight), and a text save
 * answering in the meantime leaves the previewed text alone. Call before `previewUndoOps`; returns the release.
 */
export function holdUndoReplay(queryClient: QueryClient, ops: readonly UndoOp[]): () => void
{
	const key = {};
	pendingMoves.begin(key, [...new Set(ops.flatMap((op) => touchedParents(queryClient, op)))]);
	const texts = ops.flatMap((op) => (op.kind === "edit" ? [op.nodeId] : []));
	for (const nodeId of texts)
	{
		textReplays.set(nodeId, (textReplays.get(nodeId) ?? 0) + 1);
	}
	return () =>
	{
		pendingMoves.end(key);
		for (const nodeId of texts)
		{
			const left = (textReplays.get(nodeId) ?? 1) - 1;
			if (left === 0)
			{
				textReplays.delete(nodeId);
			}
			else
			{
				textReplays.set(nodeId, left);
			}
		}
	};
}
