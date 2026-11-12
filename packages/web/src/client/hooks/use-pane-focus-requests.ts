import {useEffect} from "react";
import {requestPaneFocus} from "../pane-focus.js";
import {useOutlineStore} from "../stores/outline.js";

/**
 * Act on the store's pane focus requests (upstream's `focus.request`): after a pane opens, closes, moves or navigates,
 * put the caret on the active pane's title. A pointer or focus activation makes no request, so it never steals the caret.
 */
export function usePaneFocusRequests(): void
{
	useEffect(
		() =>
			useOutlineStore.subscribe((state, previous) =>
			{
				const request = state.paneFocusRequest;
				if (request !== null && request !== previous.paneFocusRequest)
				{
					requestPaneFocus(
						request,
						{
							resumeEditing: state.resumeEditing,
						},
					);
				}
			}),
		[],
	);
}
