import {useShallow} from "zustand/react/shallow";
import {useOutlineStore} from "../stores/outline.js";

/**
 * The outline store fields the page shell (OutlineView) lays itself out by. Selected shallowly, so editing, expansion
 * and the other per-row state never re-render the whole page; nor does a zoom or search, which `MainOutline` reads.
 */
export function useOutlineViewState()
{
	return useOutlineStore(
		useShallow((state) => (
		{
			relatedNodesPanelOpen: state.relatedNodesPanelOpen,
			paneCount: state.panes.length,
		})),
	);
}
