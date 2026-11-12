import {MAIN_PANE_ID, findPane} from "./pane-ids.js";
import {useOutlineStore} from "./stores/outline.js";

/** The pane a left-bar click navigates: the one holding the focused element, else the active pane. */
export function focusedPaneId(): string
{
	const active = document.activeElement;
	const holder = active instanceof Element ? active.closest("[data-pane-id]") : null;
	return holder?.getAttribute("data-pane-id") ?? useOutlineStore.getState().activePaneId;
}

/**
 * The side pane a plain left-bar navigation should drive, or null when the main outline should navigate: no side pane
 * is open, or the main pane is the focused one.
 */
export function focusedSidePaneId(): string | null
{
	const {panes} = useOutlineStore.getState();
	const paneId = focusedPaneId();
	return paneId !== MAIN_PANE_ID && findPane(panes, paneId) !== undefined ? paneId : null;
}

/** Zoom a side pane to a left-bar target (a plain location, so no search) and focus it. */
export function zoomFocusedPane(paneId: string, zoomedId: string | null): void
{
	const state = useOutlineStore.getState();
	state.zoomPane(paneId, zoomedId);
	state.setPaneQuery(paneId, "");
	state.setActivePane(paneId);
}
