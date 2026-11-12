import {useOutlineStore} from "./stores/outline.js";

/** What the main outline renders zoomed into a target: whether the cache holds it, and its load. */
export interface ZoomViewLoader
{
	cached: (target: string | null) => boolean;
	load: (target: string | null) => Promise<unknown>;
}

let loader: ZoomViewLoader | undefined;

/** The zoom held until its view loads, and the zoom shown when it was asked for. */
let held:
	|
	  {
			target: string | null;
			from: string | null;
	  }
	| undefined;

/** Register the main outline's view loader; the returned function unregisters it. */
export function setZoomViewLoader(next: ZoomViewLoader): () => void
{
	loader = next;
	return () =>
	{
		if (loader === next)
		{
			loader = undefined;
		}
	};
}

/**
 * Run `land` (the zoom into `target`) once the view it shows is cached: at once when it already is, else after it
 * loads. Meanwhile the whole screen (outline, title, breadcrumbs) stays on the shown view, so an uncached view swaps
 * in one commit exactly like a cached one instead of the header moving first and the rows after. A later zoom
 * replaces a held one, and a held zoom is dropped when the outline zoomed elsewhere before its view loaded.
 */
export function zoomWhenViewReady(target: string | null, land: () => void): void
{
	const from = useOutlineStore.getState().zoomedNodeId;
	if (held?.target === target && held.from === from)
	{
		return;
	}
	if (loader === undefined || target === from || loader.cached(target))
	{
		held = undefined;
		land();
		return;
	}
	const loading = loader.load(target);
	const token =
	{
		target,
		from,
	};
	held = token;
	const settle = () =>
	{
		if (held !== token)
		{
			return;
		}
		held = undefined;
		if (useOutlineStore.getState().zoomedNodeId === from)
		{
			land();
		}
	};
	loading.then(settle, settle);
}
