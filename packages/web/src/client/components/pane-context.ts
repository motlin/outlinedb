import {createContext, useContext} from "react";
import {MAIN_PANE_ID, paneExpandedIds} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";

/** The pane an outline renders in; bullet zooms inside an open pane zoom that pane instead of the main outline. */
export interface PaneContextValue
{
	id: string;
	zoom: (zoomedId: string | null) => void;
}

/** Upstream's pane header bottom border, tinted while its pane is active. */
export const PANE_HEADER_ACTIVE_BORDER = "group-data-[pane-active=true]/pane:border-b-tint";

/** Null for the main outline, which zooms by navigating the URL. */
export const PaneContext = createContext<PaneContextValue | null>(null);

/** The id of the pane the caller renders in. */
export function usePaneId(): string
{
	return useContext(PaneContext)?.id ?? MAIN_PANE_ID;
}

/** The expanded rows of the pane the caller renders in; each pane expands apart, like upstream's temporary mirror root. */
export function usePaneExpandedIds(): Set<string>
{
	const paneId = usePaneId();
	return useOutlineStore((state) => paneExpandedIds(state, paneId));
}

/**
 * Whether the calling row renders in the active pane. Editing, the item selection and caret restoration show only
 * there, so a row visible in both panes edits in one.
 */
export function useInActivePane(): boolean
{
	const paneId = usePaneId();
	return useOutlineStore((state) => state.activePaneId === paneId);
}

/**
 * Upstream's pane focus tracking: a pointerdown or focusin anywhere in the pane makes it the active pane. Like upstream's
 * `restoreCursor: false`, it does not move the caret.
 */
export function paneActivation(
	paneId: string,
	setActivePane: (paneId: string) => void,
):
{
	onPointerDown: () => void;
	onFocus: () => void;
}
{
	const activate = () =>
	{
		setActivePane(paneId);
	};
	return {
		onPointerDown: activate,
		onFocus: activate,
	};
}

/**
 * Pane `paneId`'s outline scroller. While a pane is open every pane, the main one included, scrolls its own outline;
 * the single-document main outline scrolls the window (null here).
 */
function paneScroller(paneId: string): Element | null
{
	return document.querySelector(`[data-pane-id="${paneId}"] .vertical-scrollable-container`);
}

/** How far pane `paneId`'s outline is scrolled; the window's scroll for the single-document main outline. */
export function paneScrollTop(paneId: string): number
{
	const scroller = paneScroller(paneId);
	if (scroller !== null)
	{
		return scroller.scrollTop;
	}
	return paneId === MAIN_PANE_ID ? globalThis.scrollY : 0;
}

/** Scroll pane `paneId`'s outline to `top`, through its own scroller or, for the single-document main outline, the window. */
export function scrollPaneTo(paneId: string, top: number): void
{
	const scroller = paneScroller(paneId);
	if (scroller !== null)
	{
		scroller.scrollTo(0, top);
	}
	else if (paneId === MAIN_PANE_ID)
	{
		globalThis.scrollTo(globalThis.scrollX, top);
	}
}

/** Scroll pane `paneId`'s outline to the top. */
export function scrollPaneToTop(paneId: string): void
{
	scrollPaneTo(paneId, 0);
}
