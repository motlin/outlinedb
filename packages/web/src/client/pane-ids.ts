/** The main outline's pane id; it is always rendered. Upstream gives it a random URL id once panes open. */
export const MAIN_PANE_ID = "main";

/**
 * One of upstream's secondary item-tree panes (New pane ⌃R, Open in Pane), keyed by its upstream 11-character id: its
 * own zoom, history, search and expansion, independent of the main outline's and of the other panes'.
 */
export interface ItemTreePane
{
	/** Upstream's 11-character base64url pane id; it names the pane in `panes=v2.` and `[data-pane-id]`. */
	id: string;
	/** The pane's zoomed node; null is Home. */
	zoomedId: string | null;
	/** Upstream's item-tree payload `backLocations`: earlier pane zooms, oldest first. */
	backLocations: (string | null)[];
	/** Upstream's payload `forwardLocations`: zooms stepped back from, nearest first. */
	forwardLocations: (string | null)[];
	/** The pane's own committed search query ("" for none); it filters only this pane. */
	query: string;
	/**
	 * Upstream's payload `expansionState`: the pane renders a temporary mirror root, so its rows expand apart from the
	 * other panes'. Seeded from the pane it opens from; kept in memory, never saved to the server.
	 */
	expandedIds: Set<string>;
}

/** The open secondary pane `paneId`, or undefined for the main pane and closed ids. */
export function findPane<
	T extends
	{
		id: string;
	},
>(panes: readonly T[], paneId: string): T | undefined
{
	return paneId === MAIN_PANE_ID ? undefined : panes.find((pane) => pane.id === paneId);
}

/** `paneId`'s expanded rows: an open pane's own set, else the main outline's. */
export function paneExpandedIds(
	state:
	{
		panes: readonly
		{
			id: string;
			expandedIds: Set<string>;
		}[];
		expandedIds: Set<string>;
	},
	paneId: string,
): Set<string>
{
	return findPane(state.panes, paneId)?.expandedIds ?? state.expandedIds;
}

/**
 * Upstream's `canPlacePane`: pane `paneId` (`main` for the main pane) can move to workspace index `index`, main first,
 * while panes are open. Upstream also requires the pane landing first to be an item tree, which every local pane is.
 */
export function canPlacePane(
	state:
	{
		panes: readonly
		{
			id: string;
		}[];
	},
	paneId: string,
	index: number,
): boolean
{
	const ids = [MAIN_PANE_ID, ...state.panes.map((pane) => pane.id)];
	return (
		state.panes.length > 0 && Number.isInteger(index) && index >= 0 && index < ids.length && ids.includes(paneId)
	);
}

/** The workspace index pane `paneId` moves to one place left or right, or null when it cannot (upstream's commands). */
export function paneMoveIndex(
	state:
	{
		panes: readonly
		{
			id: string;
		}[];
	},
	paneId: string,
	direction: "left" | "right",
): number | null
{
	const index = [MAIN_PANE_ID, ...state.panes.map((pane) => pane.id)].indexOf(paneId);
	const target = direction === "left" ? index - 1 : index + 1;
	return index !== -1 && canPlacePane(state, paneId, target) ? target : null;
}
