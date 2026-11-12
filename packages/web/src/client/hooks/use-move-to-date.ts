import {useQueryClient} from "@tanstack/react-query";
import {editorElement} from "../caret-dom.js";
import {viewMovedTarget} from "../move-to.js";
import {executeMirrorToDate, executeMoveToDate, moveToDateDestination} from "../move-to-date.js";
import {goToNode} from "../navigation.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {readNode} from "../node-cache.js";
import {useOutlineStore} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {loadMoveTarget, leaveRow} from "./use-move-to.js";
import {sendBlockMoves, useMirrorNodes, useMoveNodes} from "./use-nodes.js";
import {useDateSettings} from "./use-preferences.js";
import {useStableNavigate} from "./use-stable-navigate.js";

/**
 * Upstream Move to Today/Tomorrow/Next Week/7 Days Out/Date: move the items (document order) into a 📆 Calendar day,
 * created without an empty child when it is missing, as one block at the day's default slot.
 */
export function useMoveToDate():
{
	moveToPreset: (
		key: "move_to_today" | "move_to_tomorrow" | "move_to_next_week" | "move_7_days_out",
		items: readonly string[],
	) => Promise<void>;
	moveItemsToDate: (items: readonly string[], date: Date) => Promise<void>;
	mirrorItemsToDate: (items: readonly string[], date: Date) => Promise<void>;
	mirrorToToday: (items: readonly string[]) => Promise<void>;
}
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const {mutate: moveNodes} = useMoveNodes();
	const {mutate: mirrorMutate} = useMirrorNodes();
	const {weekStartDay} = useDateSettings();

	const mirrorItemsToDate = async (itemIds: readonly string[], date: Date): Promise<void> =>
	{
		const items = itemIds.filter((id) => readNode(queryClient, id) !== undefined);
		if (items.length === 0)
		{
			return;
		}
		const store = useOutlineStore.getState();
		const paneId = store.activePaneId === MAIN_PANE_ID ? null : store.activePaneId;
		// The day's ensure and the mirror write share one undo step.
		await runInUndoBatch(captureOutlineView, async () =>
			executeMirrorToDate(
				{
					items,
					date,
					fetch: globalThis.fetch,
					commitEdit: () =>
					{
						const {editingId} = useOutlineStore.getState();
						if (editingId !== null)
						{
							editorElement(editingId)?.blur();
						}
					},
					clearSelection: () =>
					{
						useOutlineStore.getState().clearItemSelection();
					},
					notify: (message, type) =>
					{
						useOutlineStore.getState().addErrorNotification(message, type);
					},
					loadTarget: loadMoveTarget,
					mirrorNodes: async (request) =>
						new Promise<number>((resolve) =>
						{
							mirrorMutate(
								request,
								{
									onSuccess: (nodes) =>
									{
										resolve(nodes.length);
									},
									onError: () =>
									{
										resolve(0);
									},
								},
							);
						}),
					showToast: ({text, timeout, actions, type}) =>
					{
						useOutlineStore.getState().showAppMessage(
							text,
							{
								timeout,
								actions,
								type,
							},
						);
					},
					view: (targetId) =>
					{
						viewMovedTarget(
							targetId,
							paneId,
							{
								zoomPane: (pane, target) =>
								{
									useOutlineStore.getState().zoomPane(pane, target);
								},
								zoomMain: (target) =>
								{
									goToNode(navigate, target);
								},
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
					onMirrored: () =>
					{
						void queryClient.invalidateQueries(
							{
								queryKey: ["calendar-dots"],
							},
						);
					},
				},
			),
		);
	};

	const moveItemsToDate = async (itemIds: readonly string[], date: Date): Promise<void> =>
	{
		const items = itemIds.filter((id) => readNode(queryClient, id) !== undefined);
		const [first] = items;
		if (first === undefined)
		{
			return;
		}
		const store = useOutlineStore.getState();
		const paneId = store.activePaneId === MAIN_PANE_ID ? null : store.activePaneId;
		await executeMoveToDate(
			{
				items,
				date,
				fetch: globalThis.fetch,
				commitEdit: () =>
				{
					const {editingId} = useOutlineStore.getState();
					if (editingId !== null)
					{
						editorElement(editingId)?.blur();
					}
				},
				clearSelection: () =>
				{
					useOutlineStore.getState().clearItemSelection();
				},
				notify: (message, type) =>
				{
					useOutlineStore.getState().addErrorNotification(message, type);
				},
				loadTarget: loadMoveTarget,
				leaveItem: () =>
				{
					leaveRow(queryClient, first);
				},
				moveNodes: (moves) =>
				{
					void runInUndoBatch(captureOutlineView, async () => sendBlockMoves(moves, moveNodes));
				},
				showToast: ({text, timeout, actions, type}) =>
				{
					useOutlineStore.getState().showAppMessage(
						text,
						{
							timeout,
							actions,
							type,
						},
					);
				},
				view: (targetId) =>
				{
					viewMovedTarget(
						targetId,
						paneId,
						{
							zoomPane: (pane, target) =>
							{
								useOutlineStore.getState().zoomPane(pane, target);
							},
							zoomMain: (target) =>
							{
								goToNode(navigate, target);
							},
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
				onMoved: () =>
				{
					void queryClient.invalidateQueries(
						{
							queryKey: ["calendar-dots"],
						},
					);
				},
			},
		);
	};

	return {
		moveItemsToDate,
		mirrorItemsToDate,
		mirrorToToday: async (items) =>
		{
			await mirrorItemsToDate(items, new Date());
		},
		moveToPreset: async (key, items) =>
		{
			await moveItemsToDate(items, moveToDateDestination(key, new Date(), weekStartDay));
		},
	};
}
