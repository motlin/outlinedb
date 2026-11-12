import {useQueryClient} from "@tanstack/react-query";
import {planCheckboxClick} from "../checkbox-complete.js";
import {usePaneId} from "../components/pane-context.js";
import {useOutlineStore} from "../stores/outline.js";
import {toggleComplete} from "./use-nodes.js";
import {activeCommandRegistry} from "./use-global-keymap.js";

/**
 * A to-do checkbox click, as upstream: the `complete` command on the clicked row (caret move, deferred hide, zoom-out),
 * or for a side pane's own zoom item a completion that leaves the caret alone and zooms that pane to the parent.
 */
export function useCheckboxComplete()
{
	const queryClient = useQueryClient();
	const paneId = usePaneId();
	return (
		node:
		{
			id: string;
			parent_id: string | null;
			completedAt: unknown;
		},
		isPaneZoomItem: boolean,
	): void =>
	{
		const store = useOutlineStore.getState();
		const isCompleted = node.completedAt !== null;
		const plan = planCheckboxClick(
			{
				isCompleted,
				paneId,
				isPaneZoomItem,
				parentId: node.parent_id,
			},
		);
		store.clearItemSelection();
		if (plan.kind === "pane")
		{
			toggleComplete(
				queryClient,
				{
					nodeId: node.id,
					isCurrentlyCompleted: isCompleted,
				},
			);
			if (plan.zoomPaneTo === null)
			{
				store.setActivePane(paneId);
			}
			else
			{
				store.zoomPane(paneId, plan.zoomPaneTo);
			}
			return;
		}
		activeCommandRegistry().complete?.execute(
			{
				items: [node.id],
				zoomedId: store.zoomedNodeId,
			},
		);
		if (plan.focusRowAfter)
		{
			store.resumeEditing(node.id, 0);
		}
	};
}
