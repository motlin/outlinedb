import type {QueryClient} from "@tanstack/react-query";
import {readChildren, readNode} from "./node-cache.js";
import type {LineSplitCreate} from "./layout-types.js";
import {sortByPriority} from "./tree-position.js";

export interface LineCreateRequest
{
	parent_id: string | undefined;
	index: number;
	name: string;
	layoutMode: string;
}

/**
 * The creates for the lines of multi-line blocks that changed type: each line is a sibling right after its row, in
 * order. Rows lower in the list go first, so the slots of the rows above them are not shifted by the new rows.
 */
export function lineSplitRequests(queryClient: QueryClient, creates: readonly LineSplitCreate[]): LineCreateRequest[]
{
	const rows = [...new Set(creates.map(({afterId}) => afterId))].map((id) =>
	{
		const parentId = readNode(queryClient, id)?.parent_id ?? null;
		const siblings = sortByPriority(readChildren(queryClient, parentId) ?? []);
		return {
			id,
			parentId,
			slot: siblings.findIndex((sibling) => sibling.id === id),
		};
	});
	return rows
		.filter(({slot}) => slot !== -1)
		.toSorted((a, b) => b.slot - a.slot)
		.flatMap(({id, parentId, slot}) =>
			creates
				.filter(({afterId}) => afterId === id)
				.map(({name, layoutMode}, offset) => (
				{
					parent_id: parentId ?? undefined,
					index: slot + 1 + offset,
					name,
					layoutMode,
				})),
		);
}
