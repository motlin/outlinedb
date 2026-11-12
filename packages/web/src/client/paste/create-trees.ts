import type {QueryClient} from "@tanstack/react-query";
import {readChildren} from "../node-cache.js";
import {syncNodeChanges} from "../hooks/use-nodes.js";
import type {CreatedIdsResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {toRequestStatusError} from "../request-error.js";
import {sortByPriority} from "../tree-position.js";
import {holdUndoSlot} from "../undo-batch.js";
import type {PasteTree} from "./apply.js";

export interface CreateTreesRequest
{
	parentId: string | null;
	/** Exact slot among the parent's children; ignored when `afterId` is given. */
	index?: number;
	afterId?: string;
	trees: PasteTree[];
}

/**
 * Create `trees` under `parentId` with one `bulk_create` (`POST /api/v1/nodes/trees`), resolving to the ids of the
 * top-level rows in order. The create joins the open undo step, then the parent's rows are refetched so the new
 * rows are in the cache when the caller moves the caret to one.
 */
export async function createTrees(queryClient: QueryClient, request: CreateTreesRequest): Promise<string[]>
{
	const siblings = sortByPriority(readChildren(queryClient, request.parentId) ?? []);
	const afterAt =
		request.afterId === undefined ? -1 : siblings.findIndex((sibling) => sibling.id === request.afterId);
	const baseIndex = afterAt === -1 ? (request.index ?? siblings.length) : afterAt + 1;
	const slot = holdUndoSlot();
	try
	{
		const response = await fetch(
			"/api/v1/nodes/trees",
			{
				method: "POST",
				headers:
				{
					"Content-Type": "application/json",
				},
				body: JSON.stringify(
					{
						parent_id: request.parentId,
						...(request.afterId === undefined
							?
								{
									index: baseIndex,
								}
							:
								{
									after_id: request.afterId,
								}),
						trees: request.trees,
					},
				),
			},
		);
		if (!response.ok)
		{
			throw await toRequestStatusError("Failed to paste", response);
		}
		const {ids} = await readJson<CreatedIdsResponse>(response);
		slot.settle(
			ids.map((nodeId, at) => (
			{
				kind: "create",
				nodeId,
				parentId: request.parentId,
				index: baseIndex + at,
			})),
		);
		await syncNodeChanges(queryClient);
		return ids;
	}
	catch (error)
	{
		slot.settle([]);
		throw error;
	}
}
