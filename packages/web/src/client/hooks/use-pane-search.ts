import {useCallback, useContext} from "react";
import {PaneContext} from "../components/pane-context.js";
import {MAIN_PANE_ID, findPane} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";
import type {NavigateFn} from "../stores/outline.js";
import {useStableNavigate} from "./use-stable-navigate.js";

/** Set the search query of the pane a click happened in: an open pane's query is its own, the main pane's commits as the page's search. */
export function setPaneSearch(paneId: string, query: string, navigate: NavigateFn): void
{
	const state = useOutlineStore.getState();
	if (findPane(state.panes, paneId) !== undefined)
	{
		state.setPaneQuery(paneId, query);
		return;
	}
	state.commitSearch(query, navigate);
}

/** `setPaneSearch` for the pane the caller renders in. */
export function usePaneSearch(): (query: string) => void
{
	const navigate = useStableNavigate();
	const paneId = useContext(PaneContext)?.id ?? MAIN_PANE_ID;
	return useCallback(
		(query: string) =>
		{
			setPaneSearch(paneId, query, navigate);
		},
		[navigate, paneId],
	);
}
