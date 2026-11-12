import {useCallback} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {internalLinkUrl} from "../item-menu-model.js";
import {nodeKeys, readNode} from "../node-cache.js";
import {runSortChildren} from "../sort-children.js";
import type {SortDirection} from "../sort-children.js";
import {useOutlineStore} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {fetchChildren, sendBlockMoves, useMoveNodes} from "./use-nodes.js";

/**
 * Upstream `copy_link`: copy the item's internal link and confirm with a brief toast. A mirror (or a backlink item)
 * copies its original's link, not its own id.
 */
export function useCopyLink(): (nodeId: string) => Promise<void>
{
	const queryClient = useQueryClient();
	const showAppMessage = useOutlineStore((state) => state.showAppMessage);
	return useCallback(
		async (nodeId) =>
		{
			const original = readNode(queryClient, nodeId)?.originalNodeId ?? nodeId;
			await navigator.clipboard.writeText(internalLinkUrl(original));
			showAppMessage(
				"Link copied.",
				{
					timeout: 1000,
				},
			);
		},
		[queryClient, showAppMessage],
	);
}

/** Upstream `sort_children_asc` / `sort_children_desc`: sort the item's children in one undo step, with a toast whose Undo pops the undo stack. */
export function useSortChildren(): (nodeId: string, direction: SortDirection) => Promise<void>
{
	const queryClient = useQueryClient();
	const {mutate: moveNodes} = useMoveNodes();
	const showAppMessage = useOutlineStore((state) => state.showAppMessage);
	return useCallback(
		async (nodeId, direction) =>
		{
			const children = await queryClient.query(
				{
					queryKey: nodeKeys.children(nodeId),
					queryFn: async () => fetchChildren(nodeId),
					staleTime: "static",
				},
			);
			await runInUndoBatch(captureOutlineView, async () =>
				runSortChildren(
					{
						parentId: nodeId,
						children: children.map((child) => (
						{
							id: child.id,
							name: child.name ?? "",
							movable: true,
						})),
						direction,
						moveNodes: async ({ids, parent_id: parentId, index}) =>
							sendBlockMoves(
								[
									{
										ids,
										parentId,
										index,
									},
								],
								moveNodes,
							),
						showToast: ({text, timeout, undoLabel, undo}) =>
						{
							showAppMessage(
								text,
								{
									timeout,
									actions: [
										{
											label: undoLabel,
											run: undo,
										},
									],
								},
							);
						},
						undo: () =>
						{
							activeCommandRegistry().undo?.execute(
								{
									items: [],
									zoomedId: null,
								},
							);
						},
					},
				),
			);
		},
		[queryClient, moveNodes, showAppMessage],
	);
}
