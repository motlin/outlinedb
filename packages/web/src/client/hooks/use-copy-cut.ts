import {useEffect} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {selectionTextOffsets} from "../caret-dom.js";
import
{
	exportItemsFromCache,
	handleCopy,
	handleCut,
	handleTitleCopyCut,
	makeChildFilter,
	searchFormatOptions,
} from "../copy-cut.js";
import type {CopyCutDeps, TitleSelection} from "../copy-cut.js";
import {serializeEditorHtml} from "../editor-html.js";
import {sortedIds} from "../item-selection.js";
import {readChildren, readNode} from "../node-cache.js";
import {cutUndoMatch} from "../cut-registry.js";
import {hideBanner, showBanner} from "../stores/banner.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {currentSearchFilter} from "./use-tree-search.js";
import {useStableNavigate} from "./use-stable-navigate.js";
import {useDeleteNode} from "./use-nodes.js";
import {currentSelectionView, deleteSelectedItems, isTextTarget} from "./use-selection-keymap.js";

function titleContentOf(node: Node | null): Element | null
{
	return (
		(node instanceof Element ? node : (node?.parentElement ?? null))?.closest(".name.name--main > .content") ?? null
	);
}

/** The zoom-root title the DOM selection lies in (upstream `.name.name--main > .content`), or null. */
function titleSelection(): TitleSelection | null
{
	const selection = globalThis.getSelection();
	if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
	{
		return null;
	}
	const content = titleContentOf(selection.anchorNode);
	if (!(content instanceof HTMLElement) || content !== titleContentOf(selection.focusNode))
	{
		return null;
	}
	const {start, end} = selectionTextOffsets(content);
	return {
		stored: serializeEditorHtml(content.innerHTML),
		start,
		end,
		text: selection.toString(),
	};
}

function depsFor(
	queryClient: QueryClient,
	deleteNode: (id: string) => void,
	navigate: Parameters<typeof deleteSelectedItems>[3],
): CopyCutDeps
{
	return {
		selected: () =>
		{
			const {itemSelection} = useOutlineStore.getState();
			return itemSelection.entries.length === 0
				? []
				: sortedIds(itemSelection, currentSelectionView(queryClient).tree);
		},
		items: (ids) => exportItemsFromCache(queryClient, ids),
		get childFilter()
		{
			const {expandedIds, zoomedNodeId, showCompleted} = activePaneView();
			return makeChildFilter(
				{
					expandedIds,
					zoomedId: zoomedNodeId,
					showCompleted,
					search: currentSearchFilter(queryClient),
				},
			);
		},
		get format()
		{
			return searchFormatOptions(currentSearchFilter(queryClient) === null ? "" : activePaneView().searchQuery);
		},
		canCut: (id) =>
		{
			const node = readNode(queryClient, id);
			return node !== undefined && node.readOnly !== true;
		},
		childIds: (id) =>
		{
			const children = readChildren(queryClient, id);
			if (children === undefined)
			{
				return readNode(queryClient, id)?.hasChildren === true ? [`${id}:unloaded`] : [];
			}
			return children.map((child) => child.id);
		},
		deleteRows: (ids) =>
		{
			deleteSelectedItems(
				queryClient,
				ids,
				deleteNode,
				navigate,
				{
					confirm: false,
				},
			);
		},
		clearSelection: () =>
		{
			useOutlineStore.getState().clearItemSelection();
		},
		showBanner: (text, restore) =>
		{
			showBanner(
				text,
				{
					kind: "info",
					action:
					{
						label: "Restore.",
						run: restore,
					},
				},
			);
		},
		restore: (ids) =>
		{
			activeCommandRegistry().undo?.execute(
				{
					items: [],
					zoomedId: useOutlineStore.getState().zoomedNodeId,
					undoMatch: cutUndoMatch(ids),
				},
			);
			hideBanner();
		},
		schedule: (run) =>
		{
			setTimeout(run, 0);
		},
	};
}

/**
 * Upstream's `window` `copy` and `cut` listeners (bubble phase): with an item selection they put the selected rows'
 * Formatted html and plain text on the clipboard (cut then deletes them); inside the zoom-root title they write the
 * raw markup of the selected range. Anywhere else the browser's native copy/cut runs.
 */
export function useCopyCut(): void
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const {mutate: deleteNode} = useDeleteNode();
	useEffect(() =>
	{
		const deps = depsFor(queryClient, deleteNode, navigate);
		const listener = (cut: boolean) => (event: ClipboardEvent) =>
		{
			if (event.defaultPrevented)
			{
				return;
			}
			if (!isTextTarget(event.target) && (cut ? handleCut(event, deps) : handleCopy(event, deps)))
			{
				return;
			}
			if (useOutlineStore.getState().itemSelection.entries.length === 0)
			{
				handleTitleCopyCut(event, cut, titleSelection(), () =>
				{
					// oxlint-disable-next-line typescript/no-deprecated -- the editor's own edit path (input event, undo step)
					document.execCommand("delete");
				});
			}
		};
		const onCopy = listener(false);
		const onCut = listener(true);
		globalThis.addEventListener("copy", onCopy);
		globalThis.addEventListener("cut", onCut);
		return () =>
		{
			globalThis.removeEventListener("copy", onCopy);
			globalThis.removeEventListener("cut", onCut);
		};
	}, [queryClient, deleteNode, navigate]);
}
