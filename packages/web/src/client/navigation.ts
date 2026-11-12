import {isShortId, parseVirtualShortId, virtualShortId} from "@outlinedb/shared/workflowy";
import type {MirrorInstance} from "../mirror-path.js";
import {useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import {NavigationType, useLocation, useNavigationType} from "react-router-dom";
import {useStableNavigate} from "./hooks/use-stable-navigate.js";
import type {NodeResponse} from "../node-types.js";
import {useDeleteNode} from "./hooks/use-nodes.js";
import {afterNextPaint} from "./after-paint.js";
import {caretTextOffset, editorElement, rowContent} from "./caret-dom.js";
import {locationUrl, parseLocationHash, shortId} from "./location.js";
import {readChildren, readNode} from "./node-cache.js";
import {locFromHash} from "./nav-stack.js";
import type {Loc} from "./nav-stack.js";
import {workspaceFragments} from "./pane-url.js";
import {useOutlineStore} from "./stores/outline.js";
import type {NavigateFn} from "./stores/outline.js";
import {zoomWhenViewReady} from "./zoom-gate.js";
import {focusQuietlyNext} from "./quiet-focus.js";
import {oweAppStepScroll} from "./scroll-restoration.js";
import {dropViewRestore, oweViewRestore} from "./view-state.js";

/**
 * The client URL for a node view: upstream's `/#/<last 12 chars of uuid>`.
 *
 * The hash router resolves the short id back to the full uuid before zooming, so
 * `zoomedNodeId` always holds a full id. Every node link must go through this
 * helper so the form stays consistent.
 */
export function nodeUrl(nodeId: string, instance: MirrorInstance | null = null): string
{
	if (instance !== null)
	{
		return `/#/${virtualShortId(
			{
				childId: nodeId,
				mirrorRootId: instance.rootId,
				path: instance.path,
			},
		)}`;
	}
	return locationUrl(
		{
			id: nodeId,
		},
	);
}

/**
 * Resolve a location id to a zoom target: `"home"` for no id, a full uuid as is,
 * and a 12-hex short id through `lookup` (null when it is unknown).
 */
/**
 * What a bullet click does, in upstream's order: a click whose press the drag did not arm is ignored; a click on a
 * selected row clears the selection; a Cmd/Ctrl click or a non-left button is left to the browser so it opens the
 * bullet's href in a new tab; anything else zooms in-app.
 */
export function bulletClickAction(event: {
	metaKey: boolean;
	ctrlKey: boolean;
	button: number;
	armed: boolean;
	inSelection: boolean;
}): "ignore" | "clear-selection" | "browser" | "zoom"
{
	if (!event.armed)
	{
		return "ignore";
	}
	if (event.inSelection)
	{
		return "clear-selection";
	}
	return event.metaKey || event.ctrlKey || event.button !== 0 ? "browser" : "zoom";
}

export function resolveZoomTarget(param: string | null, lookup: (id: string) => string | null)
{
	if (param === null)
	{
		return "home";
	}
	return isShortId(param) || parseVirtualShortId(param) !== null ? lookup(param) : param;
}

export type ZoomFocus = "first_child" | "last_selected";

export interface ZoomFocusInput
{
	zoomedId: string | null;
	/** `first_child`: the node to zoom into (null for home). Unused by `last_selected`. */
	targetId: string | null;
	/** The target's first potentially visible child. */
	firstChildId: string | null;
	parentOfZoomed: string | null;
	/** The row edited before the zoom, and its caret offset. */
	previousEditingId: string | null;
	previousOffset: number;
}

export interface ZoomFocusPlan
{
	route: string;
	/** The row to edit after navigating, or null to stop editing. */
	editId: string | null;
	offset: number;
	/** Scroll the outline to the top. */
	scrollTop: boolean;
}

/**
 * Upstream `zoomTo(target, focus)`. `first_child` (bullet click, zoom_in) zooms into the target and edits its first
 * visible child, or its title when it has none (nothing at home), keeping the old caret offset when that row already
 * had focus, then scrolls to the top. `last_selected` (zoom_out) zooms to the parent and edits the node zoomed out of
 * at offset 0. Null when there is nothing to do: the target is already zoomed, or zooming out at the root.
 */
export function planZoomFocus(
	focus: ZoomFocus,
	{zoomedId, targetId, firstChildId, parentOfZoomed, previousEditingId, previousOffset}: ZoomFocusInput,
): ZoomFocusPlan | null
{
	if (focus === "first_child")
	{
		if (targetId === zoomedId)
		{
			return null;
		}
		const editId = firstChildId ?? targetId;
		const offset = editId !== null && editId === previousEditingId ? previousOffset : 0;
		return {
			route: targetId === null ? "/" : nodeUrl(targetId),
			editId,
			offset,
			scrollTop: true,
		};
	}
	if (zoomedId === null)
	{
		return null;
	}
	return {
		route: parentOfZoomed === null ? "/" : nodeUrl(parentOfZoomed),
		editId: zoomedId,
		offset: previousEditingId === zoomedId ? previousOffset : 0,
		scrollTop: false,
	};
}

export type ZoomStep = "animate-in" | "navigate" | "animate-out" | "focus";

/**
 * The order of a zoom's phases. Zooming in animates, navigates, then focuses; zooming out navigates, animates, then
 * focuses, because the animation hides the row until it ends and a caret set earlier would be lost.
 */
export function zoomSteps({animate, isOut, hasEdit}: {animate: boolean; isOut: boolean; hasEdit: boolean}): ZoomStep[]
{
	const steps: ZoomStep[] = [];
	if (animate && !isOut)
	{
		steps.push("animate-in");
	}
	steps.push("navigate");
	if (animate && isOut)
	{
		steps.push("animate-out");
	}
	if (hasEdit)
	{
		steps.push("focus");
	}
	return steps;
}

/**
 * Keep the edited row from focusing inside the frame that swaps the outline: stop editing for the swap, then resume at
 * the same caret after the paint (when nothing else took the edit meanwhile), without scrolling to the row. A row that mounts editing focuses in its
 * commit, which forces a style and layout pass of the whole new view inside that frame; after the paint it is cheap.
 */
function holdEditingAcrossSwap(): void
{
	const {editingId, editingCaretOffset, stopEditing} = useOutlineStore.getState();
	if (editingId === null)
	{
		return;
	}
	const editor = editorElement(editingId);
	const offset = editor === null ? (editingCaretOffset ?? 0) : caretTextOffset(editor);
	stopEditing();
	void (async () =>
	{
		await afterNextPaint();
		const state = useOutlineStore.getState();
		// A row the new view does not show is not resumed: the store would say "editing" with focus on BODY.
		if (state.editingId === null && rowContent(editingId) !== null)
		{
			focusQuietlyNext(editingId);
			state.resumeEditing(editingId, offset);
		}
	})();
}

/**
 * Record a move to `nodeId` (null for home) on the in-app stacks, zoom the outline, then push its URL carrying any
 * open panes. Zooming here rather than after the route resolves the URL's short id swaps the outline in the same
 * frame as the click, and keeping the `panes` param spares the pane sync a second, replacing navigation. A view the
 * cache lacks holds the zoom until it loads (`zoomWhenViewReady`), so it swaps whole like a cached one.
 */
export function goToNode(
	navigate: NavigateFn,
	nodeId: string | null,
	query: string | null = null,
	/** A pane open/close/move promoted this location: it pushes like a navigation, as upstream's workspace edits do. */
	structural = false,
	/** The mirror instance the row was met in: the location is its virtual `v_…` id and the zoom keeps the instance. */
	instance: MirrorInstance | null = null,
): void
{
	const {dispatchNav, zoom, panes, mainPaneUrlId} = useOutlineStore.getState();
	dropViewRestore();
	// Upstream replaces the entry while panes are open and leaves the app stacks alone.
	const replace = panes.length > 0 && !structural;
	const url = locationUrl(
		{
			id: nodeId,
			instance,
			query,
			fragments: workspaceFragments(panes, mainPaneUrlId),
		},
	);
	const locId =
		nodeId === null
			? null
			: instance === null
				? shortId(nodeId)
				: virtualShortId(
						{
							childId: nodeId,
							mirrorRootId: instance.rootId,
							path: instance.path,
						},
					);
	dispatchNav(
		{
			type: replace ? "replace" : "navigate",
			loc:
			{
				id: locId,
				query,
			},
		},
	);
	zoomWhenViewReady(nodeId, () =>
	{
		if (nodeId !== useOutlineStore.getState().zoomedNodeId)
		{
			holdEditingAcrossSwap();
		}
		zoom(nodeId, instance);
	});
	void (replace
		? navigate(
				url,
				{
					replace: true,
				},
			)
		: navigate(url));
}

/**
 * Upstream's close of the main pane: the first pane becomes the main outline, so the URL navigates to its zoom and
 * search while the remaining panes stay open. A no-op with no pane open.
 */
export function closeMainPane(navigate: NavigateFn): void
{
	const promoted = useOutlineStore.getState().closeMainPane();
	if (promoted !== null)
	{
		goToNode(navigate, promoted.zoomedId, promoted.query === "" ? null : promoted.query, true);
	}
}

/**
 * Upstream's `movePane`: move pane `paneId` (`main` for the main pane) to workspace index `index`. When another pane
 * lands first it becomes the main outline, so the URL navigates to its zoom and search; otherwise the pane sync pushes
 * the reordered `panes` param.
 */
export function movePane(
	navigate: NavigateFn,
	paneId: string,
	index: number,
	/** Expand a location's short id to the node id (from the cache) so the demoted main pane can zoom back to it. */
	resolveId?: (locationId: string) => string,
): void
{
	const promoted = useOutlineStore.getState().movePane(paneId, index, resolveId)?.promoted ?? null;
	if (promoted !== null)
	{
		// The promoted pane arrives with its own history; navigating to it must not add the old main location to it.
		const {mainPaneHistory} = useOutlineStore.getState();
		goToNode(navigate, promoted.zoomedId, promoted.query === "" ? null : promoted.query, true);
		useOutlineStore.setState(
			{
				mainPaneHistory,
			},
		);
	}
}

/**
 * Commit a search: push the zoomed node's URL with `?q=<query>` through the same
 * navigate path as a node move (an empty query clears it). A new query on the same
 * node is a distinct location, so it is never deduped.
 */
export function navigateToSearch(navigate: NavigateFn, query: string): void
{
	useOutlineStore.getState().pushSearchLocation(query, navigate);
}

/**
 * Zoom the outline to the node `hash` names when `resolve` finds its full id in the cache (home for no id), so the
 * outline swaps in the same render as the URL change rather than after the hash route resolves it, or, when its view
 * is not cached, in the render after the view loads. An id the cache cannot resolve leaves the zoom to the route.
 */
export function zoomToCachedLocation(hash: string, resolve: (locationId: string) => string | undefined): void
{
	zoomToCachedId(parseLocationHash(hash).id, resolve);
}

function zoomToCachedId(locationId: string | null, resolve: (locationId: string) => string | undefined): void
{
	const target = locationId === null ? null : resolve(locationId);
	if (target === undefined)
	{
		return;
	}
	// A virtual location also names the mirror root the row was met in; a root the cache lacks zooms the plain row.
	const virtual = locationId === null ? null : parseVirtualShortId(locationId);
	const rootId = virtual === null ? undefined : resolve(virtual.mirrorShortId);
	const instance =
		virtual === null || rootId === undefined
			? null
			:
				{
					rootId,
					path: virtual.path,
				};
	zoomWhenViewReady(target, () =>
	{
		const state = useOutlineStore.getState();
		if (target !== state.zoomedNodeId || instance?.rootId !== state.zoomedInstance?.rootId)
		{
			holdEditingAcrossSwap();
			state.zoom(target, instance);
		}
	});
}

/**
 * Upstream's Back/Forward: step the in-app stacks (the main pane history while panes are open) and push a new browser
 * entry for the target, keeping the open panes (never `history.back()`); a no-op when that stack is empty.
 * A target `resolve` finds in the cache is zoomed before the push, as `goToNode` does, and the outline returns to the
 * scroll the target was left at, as upstream's does (while no pane is open, when the window scrolls the outline).
 */
export function stepNav(
	navigate: NavigateFn,
	direction: "back" | "forward",
	resolve: (locationId: string) => string | undefined,
): void
{
	const {nav: before, dispatchNav, panes: panesBefore, stepMainPaneHistory} = useOutlineStore.getState();
	let target: Loc | null;
	if (panesBefore.length > 0)
	{
		target = stepMainPaneHistory(direction);
	}
	else if ((direction === "back" ? before.back : before.forward).length === 0)
	{
		return;
	}
	else
	{
		dispatchNav(
			{
				type: direction,
			},
		);
		target = useOutlineStore.getState().nav.current;
	}
	if (target !== null)
	{
		const {panes, mainPaneUrlId} = useOutlineStore.getState();
		if (panes.length === 0)
		{
			oweAppStepScroll(target);
		}
		oweViewRestore(target);
		zoomToCachedId(target.id, resolve);
		void navigate(
			locationUrl(
				{
					...target,
					fragments: workspaceFragments(panes, mainPaneUrlId),
				},
			),
		);
	}
}

/**
 * Fold a router location change into the stacks: browser Back/Forward (`isPop`)
 * sets the current location only; anything else (a link click) is a navigation,
 * deduped against the URL the app itself just pushed. A replaced entry, or the push of the canonical URL for an unknown
 * id, sets the current location only, as upstream's `replaceState` and root fallback leave the stacks alone.
 */
export function syncNavLocation(hash: string, isPop: boolean, isReplace = false): void
{
	const loc = locFromHash(hash);
	const type = isReplace ? "replace" : isPop ? "popstate" : "navigate";
	useOutlineStore.getState().dispatchNav(
		{
			type,
			loc,
		},
	);
}

export interface EmptyDayCleanupDeps
{
	getNode: (id: string) => NodeResponse | undefined;
	getChildren: (id: string) => readonly NodeResponse[] | undefined;
	deleteNode: (id: string) => unknown;
}

/**
 * Upstream `ZX4` (`location.change.before`): leaving a 📆 Calendar day page for a
 * node not inside it deletes the day's child when it is the only one and is
 * empty (no name, note or children) and writable, so a visited-and-left day keeps
 * no blank row. A childless lone child means the day's only descendant is that
 * child, so "not inside" is "not the day and not the child".
 */
export function cleanupEmptyDayOnLeave(fromId: string | null, toId: string | null, deps: EmptyDayCleanupDeps): void
{
	if (fromId === null || fromId === toId || deps.getNode(fromId)?.calendar?.level !== "day")
	{
		return;
	}
	const children = deps.getChildren(fromId);
	const child = children?.length === 1 ? children[0] : undefined;
	if (child === undefined)
	{
		return;
	}
	const empty = (child.name ?? "") === "" && (child.note ?? "") === "" && child.hasChildren !== true;
	if (empty && child.isMirror !== true && child.id !== toId)
	{
		deps.deleteNode(child.id);
	}
}

/** Run the empty-day cleanup whenever the zoomed node changes. Mount once (the outline route owns it). */
export function useEmptyDayCleanup(): void
{
	const queryClient = useQueryClient();
	const {mutate: deleteNode} = useDeleteNode();
	const zoomedNodeId = useOutlineStore((state) => state.zoomedNodeId);
	const previous = useRef(zoomedNodeId);

	useEffect(() =>
	{
		const fromId = previous.current;
		previous.current = zoomedNodeId;
		cleanupEmptyDayOnLeave(
			fromId,
			zoomedNodeId,
			{
				getNode: (id) => readNode(queryClient, id),
				getChildren: (id) => readChildren(queryClient, id),
				deleteNode,
			},
		);
	}, [deleteNode, queryClient, zoomedNodeId]);
}

/** Keep the in-app stacks in step with the outline route's URL. Mount once (the top bar owns it). */
export function useNavStackSync(): void
{
	const location = useLocation();
	const navigationType = useNavigationType();

	useEffect(() =>
	{
		if (location.pathname === "/")
		{
			const state: unknown = location.state;
			const canonical =
				typeof state === "object" && state !== null && "wfCanonical" in state && state.wfCanonical === true;
			syncNavLocation(
				location.hash,
				navigationType === NavigationType.Pop,
				canonical || navigationType === NavigationType.Replace,
			);
		}
	}, [location, navigationType]);
}

export function useNodeNavigation()
{
	const navigate = useStableNavigate();

	return {
		navigateToNode: (nodeId: string | null, instance: MirrorInstance | null = null) =>
		{
			goToNode(navigate, nodeId, null, false, instance);
		},
		navigateToRoot: () =>
		{
			goToNode(navigate, null);
		},
		navigateToSearch: (query: string) =>
		{
			navigateToSearch(navigate, query);
		},
		cancelSearch: () =>
		{
			useOutlineStore.getState().cancelSearch(navigate);
		},
	};
}
