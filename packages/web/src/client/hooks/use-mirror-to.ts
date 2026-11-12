import {stripHtmlTags} from "@outlinedb/shared/html";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useStableNavigate} from "./use-stable-navigate.js";
import {caretTextOffset, editorElement} from "../caret-dom.js";
import
{
	MIRROR_COPIED_TOAST,
	executeMirrorHere,
	executeMirrorTo,
	mirrorClipboardHtml,
	mirrorSourceIds,
	shouldDeleteMirrorTrigger,
} from "../mirror-commands.js";
import type {MirrorRequest} from "../mirror-commands.js";
import {viewMovedTarget} from "../move-to.js";
import {goToNode} from "../navigation.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {readChildren, readNode} from "../node-cache.js";
import {sortByPriority} from "../tree-position.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import type {CaretReturn} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {detachMirrorNode, fetchNode, swapMirrorOriginNode, useDeleteNode, useMirrorNodes} from "./use-nodes.js";
import {isMirrorRoot} from "../components/row-classes.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {loadMoveTarget, moveToAnchor} from "./use-move-to.js";

type MirrorMutate = ReturnType<typeof useMirrorNodes>["mutate"];

/** Runs the mirror write and resolves to how many mirrors it made; a failed write is reported by the mutation. */
async function mirrorCount(mutate: MirrorMutate, request: MirrorRequest): Promise<number>
{
	return new Promise<number>((resolve) =>
	{
		mutate(
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
	});
}

function showMirrorToast(toast: {
	text: string;
	timeout: number;
	actions: readonly
	{
		label: string;
		run: () => void;
	}[];
	type?: "success" | "warning" | "failure";
}): void
{
	useOutlineStore.getState().showAppMessage(
		toast.text,
		{
			timeout: toast.timeout,
			actions: toast.actions,
			type: toast.type,
		},
	);
}

function undoLast(): void
{
	activeCommandRegistry().undo?.execute(
		{
			items: [],
			zoomedId: null,
		},
	);
}

function pickerContext(itemId: string)
{
	const store = useOutlineStore.getState();
	const editor = store.editingId === itemId ? editorElement(itemId) : null;
	const returnTo: CaretReturn | undefined =
		editor === null
			? undefined
			:
				{
					nodeId: itemId,
					offset: caretTextOffset(editor),
				};
	return {
		store,
		editor,
		returnTo,
	};
}

function siblingIndexOf(queryClient: QueryClient, itemId: string, parentId: string | null): number
{
	const siblings = sortByPriority(readChildren(queryClient, parentId) ?? []);
	return siblings.findIndex((sibling) => sibling.id === itemId);
}

/**
 * Upstream Mirror To... (bullet menu, slash, palette): open the location picker, mirror the items into the chosen
 * location, and toast `mirrored to '<name>'` with View and Undo.
 */
export function useMirrorTo(): (itemIds: readonly string[]) => Promise<void>
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const {mutate} = useMirrorNodes();
	return async (itemIds) =>
	{
		const items = itemIds.filter((id) => readNode(queryClient, id) !== undefined);
		const [first] = items;
		if (first === undefined)
		{
			return;
		}
		const {store, editor, returnTo} = pickerContext(first);
		const paneId = store.activePaneId === MAIN_PANE_ID ? null : store.activePaneId;
		store.clearItemSelection();
		await executeMirrorTo(
			{
				items,
				pick: async () =>
					store.openLocationPicker(
						{
							forItemId: first,
							headerText: "Mirror To...",
						},
						moveToAnchor(first, editor),
						returnTo,
					),
				loadTarget: loadMoveTarget,
				mirrorNodes: async (request) =>
					runInUndoBatch(captureOutlineView, async () => mirrorCount(mutate, request)),
				showToast: showMirrorToast,
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
				undo: undoLast,
			},
		);
	};
}

/**
 * Upstream Mirror Here...: pick the item to mirror, put its mirror under the row's parent right after the row (or at
 * the top of the zoom root), delete the row when it was blank, and toast `mirrored '<name>' here`.
 */
export function useMirrorHere(): (itemId: string) => Promise<void>
{
	const queryClient = useQueryClient();
	const {mutate} = useMirrorNodes();
	const deleteNode = useDeleteNode();
	return async (itemId) =>
	{
		const row = readNode(queryClient, itemId);
		if (row === undefined)
		{
			return;
		}
		const {store, editor, returnTo} = pickerContext(itemId);
		const isZoomRoot = activePaneView().zoomedNodeId === itemId;
		await executeMirrorHere(
			{
				pick: async () =>
					store.openLocationPicker(
						{
							forItemId: itemId,
							headerText: "Mirror Here...",
						},
						moveToAnchor(itemId, editor),
						returnTo,
					),
				loadName: async (id) => (await fetchNode(id)).name ?? "",
				plan: (picked) => (
				{
					item_ids: [picked],
					parent_id: isZoomRoot ? itemId : row.parent_id,
					index: isZoomRoot ? 0 : siblingIndexOf(queryClient, itemId, row.parent_id) + 1,
				}),
				// One undo step: the mirror and the blank trigger row's deletion.
				mirrorNodes: async (request) =>
					runInUndoBatch(captureOutlineView, async () =>
					{
						const made = await mirrorCount(mutate, request);
						const current = readNode(queryClient, itemId) ?? row;
						if (
							made > 0 &&
							shouldDeleteMirrorTrigger(
								{
									name: current.name ?? "",
									note: current.note ?? "",
									childCount: readChildren(queryClient, itemId)?.length ?? 0,
									isZoomRoot,
									readOnly: current.readOnly === true,
								},
							)
						)
						{
							deleteNode.mutate(itemId);
						}
						return made;
					}),
				deleteTrigger: () =>
				{
				},
				showToast: showMirrorToast,
				undo: undoLast,
			},
		);
	};
}

/**
 * Upstream Mirror (⇧⌘M, "Live copy"): put `<div data-wf-mirror="<original id>">` per item on the clipboard and toast
 * that it is ready to paste. The caret stays where it was; pasting creates the mirrors (see `planItemPaste`).
 */
export function useMirrorCopy(): (itemIds: readonly string[]) => void
{
	const queryClient = useQueryClient();
	return (itemIds) =>
	{
		const sources = mirrorSourceIds(itemIds, (id) => readNode(queryClient, id));
		if (sources.length === 0)
		{
			return;
		}
		const store = useOutlineStore.getState();
		store.clearItemSelection();
		const html = mirrorClipboardHtml(sources);
		const text = sources.map((id) => stripHtmlTags(readNode(queryClient, id)?.name ?? "")).join("\n");
		void (async () =>
		{
			try
			{
				await navigator.clipboard.write([
					new ClipboardItem(
						{
							"text/html": new Blob(
								[html],
								{
									type: "text/html",
								},
							),
							"text/plain": new Blob(
								[text],
								{
									type: "text/plain",
								},
							),
						},
					),
				]);
			}
			catch
			{
				await navigator.clipboard.writeText(text);
			}
			store.showAppMessage(
				MIRROR_COPIED_TOAST.text,
				{
					timeout: MIRROR_COPIED_TOAST.timeout,
					dismissOn: MIRROR_COPIED_TOAST.dismissOn,
				},
			);
		})();
	};
}

/** Whether the cached row is a mirror root: a mirror, or an original that has mirrors. */
export function isMirrorRootId(queryClient: QueryClient, id: string): boolean
{
	const node = readNode(queryClient, id);
	return node !== undefined && isMirrorRoot(node);
}

/** Upstream Detach Mirror: replace the mirror root with a plain copy in its slot; a zoomed root zooms to the copy. */
export function useDetachMirror(): (itemId: string) => Promise<void>
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	return async (itemId) =>
	{
		const wasZoomRoot = activePaneView().zoomedNodeId === itemId;
		const copyId = await runInUndoBatch(captureOutlineView, async () =>
			detachMirrorNode(queryClient, itemId),
		).catch((error: unknown) =>
		{
			useOutlineStore
				.getState()
				.addErrorNotification(`Failed to detach mirror: ${error instanceof Error ? error.message : "error"}`);
			return;
		});
		if (wasZoomRoot && copyId !== undefined)
		{
			goToNode(navigate, copyId);
		}
	};
}

/** Mirrors: Swap origin (palette): the mirror and its original exchange slots; an original warns for 2s. */
export function useSwapMirrorOrigin(): (itemId: string) => Promise<void>
{
	const queryClient = useQueryClient();
	return async (itemId) =>
	{
		const warning = await runInUndoBatch(captureOutlineView, async () =>
			swapMirrorOriginNode(queryClient, itemId),
		).catch((error: unknown) =>
		{
			useOutlineStore
				.getState()
				.addErrorNotification(`Failed to swap origin: ${error instanceof Error ? error.message : "error"}`);
			return;
		});
		if (warning !== undefined)
		{
			useOutlineStore.getState().showAppMessage(
				warning,
				{
					timeout: SWAP_WARNING_TIMEOUT,
					type: "warning",
				},
			);
		}
	};
}

const SWAP_WARNING_TIMEOUT = 2000;
