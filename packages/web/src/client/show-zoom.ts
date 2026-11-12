export interface ShowZoomDeps
{
	/** The active open pane, or null while the main outline is active. */
	paneId: string | null;
	zoomPane: (paneId: string, id: string | null) => void;
	goToNode: (id: string | null) => void;
	/** Scroll pane `paneId`'s scroller (the window for null) to the top. */
	scrollToTop: (paneId: string | null) => void;
}

/** Show `destination` in the active pane: zoom an open pane while it is active, else navigate the main outline. */
export function showZoom(destination: string | null, scrollTop: boolean, deps: ShowZoomDeps): void
{
	if (deps.paneId === null)
	{
		deps.goToNode(destination);
	}
	else
	{
		deps.zoomPane(deps.paneId, destination);
	}
	if (scrollTop)
	{
		deps.scrollToTop(deps.paneId);
	}
}

/**
 * The root an outline renders: the requested zoom, except while its children are still loading, when the previously
 * shown root (Home is null) stays on screen so the swap lands in one frame instead of flashing "Loading...". With
 * nothing shown yet (`undefined`) the requested root renders its loading state.
 */
export function outlineRootToShow(
	requested: string | null,
	loading: boolean,
	lastShown: string | null | undefined,
): string | null
{
	return loading && lastShown !== undefined ? lastShown : requested;
}
